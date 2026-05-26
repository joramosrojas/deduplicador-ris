"""
Deduplicador RIS — Backend Masivo
FastAPI server: serves the existing static HTML frontend + API for large-scale dedup.

Start: python main.py
Then open: http://localhost:8000

Para abrirlo debod pegar esto en la terminal
cd "/Users/josetomasramosrojas/python_projects/Deduplicador RIS/backend"
./start.sh
"""
import csv
import datetime
import io
import json
import os
import shutil
import tempfile
import threading
import uuid
import webbrowser
from pathlib import Path
from typing import Optional

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from dedup_engine import run_dedup
from ris_parser import detect_format, parse_nbib, parse_ris, refs_to_ris
import database as db

app = FastAPI(title="Deduplicador RIS – Backend Masivo")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory job store  {job_id: {...}}
jobs: dict[str, dict] = {}

# Persistent sessions directory (used as fallback when DATABASE_URL is not set)
SESSIONS_DIR = Path(__file__).parent / 'sessions'
SESSIONS_DIR.mkdir(exist_ok=True)

db.init_db()

# ── Helpers ──────────────────────────────────────────────────

_REASON_PRIORITY = {'doi': 0, 'an': 1, 'title_abstract': 2, 'title': 3, 'journal': 4}


def _primary_reason(group: dict) -> str:
    best = None
    for p in group['pairs']:
        r = p.get('reason', 'title')
        if best is None or _REASON_PRIORITY.get(r, 99) < _REASON_PRIORITY.get(best, 99):
            best = r
    return best or 'title'


def _max_score(group: dict) -> float:
    """Handles both snake_case (Python engine) and camelCase (JS engine) group dicts."""
    return group.get('max_score') or group.get('maxScore') or 0.0


def _categorize(group: dict) -> str:
    reason = _primary_reason(group)
    score  = _max_score(group)
    if reason == 'doi':             return 'doi'
    if reason == 'an':              return 'an'
    if score >= 0.90:               return 'high'
    if score >= 0.75:               return 'med'
    return 'low'


def _ref_summary(ref: dict) -> dict:
    return {
        'title':     (ref.get('title') or '')[:140],
        'accession': ref.get('accession') or '',
        'authors':   (ref.get('authors') or '').split(';')[0].strip(),
        'year':      ref.get('year') or '',
        'source':    ref.get('_source') or '',
        'doi':       ref.get('doi') or '',
    }


def _build_cats(all_refs: list, groups: list) -> tuple[dict, dict]:
    """Categorize groups; returns (cats_internal, response_cats)."""
    cats = {k: {'count': 0, 'refs_affected': 0, 'sample': [], 'group_indices': []}
            for k in ('doi', 'an', 'high', 'med', 'low')}
    for gi, group in enumerate(groups):
        cat = _categorize(group)
        cats[cat]['count'] += 1
        cats[cat]['refs_affected'] += len(group['members'])
        cats[cat]['group_indices'].append(gi)
        if len(cats[cat]['sample']) < 5:
            cats[cat]['sample'].append({
                'max_score': round(_max_score(group), 3),
                'reason':    _primary_reason(group),
                'members':   [_ref_summary(all_refs[idx]) for idx in group['members'][:3]],
            })
    response_cats = {
        k: {'count': v['count'], 'refs_affected': v['refs_affected'], 'sample': v['sample']}
        for k, v in cats.items()
    }
    return cats, response_cats


# ── Session persistence ───────────────────────────────────────

def _save_session(job_id: str, filenames: list[str]):
    """Persist a completed job — to the database if available, otherwise to disk."""
    job  = jobs[job_id]
    name = job.get('session_name') or ', '.join(filenames) or 'Sin nombre'
    mode = job.get('mode_type', 'massive')

    if db.available():
        db.save_session(
            job_id=job_id,
            name=name,
            mode=mode,
            created_at=job.get('created_at', ''),
            filenames=filenames,
            total_refs=job['total_refs'],
            total_groups=job['total_groups'],
            response_cats=job['response_cats'],
            refs=job['refs'],
            groups=job['groups'],
            cats=job['cats'],
        )
        return

    # Filesystem fallback
    sd = SESSIONS_DIR / job_id
    sd.mkdir(exist_ok=True)
    (sd / 'meta.json').write_text(json.dumps({
        'job_id':        job_id,
        'name':          name,
        'mode':          mode,
        'created_at':    job.get('created_at', ''),
        'filenames':     filenames,
        'total_refs':    job['total_refs'],
        'total_groups':  job['total_groups'],
        'response_cats': job['response_cats'],
    }, ensure_ascii=False), encoding='utf-8')
    (sd / 'refs.json').write_text(
        json.dumps(job['refs'],   ensure_ascii=False), encoding='utf-8')
    (sd / 'groups.json').write_text(
        json.dumps(job['groups'], ensure_ascii=False), encoding='utf-8')
    (sd / 'cats.json').write_text(
        json.dumps(job['cats'],   ensure_ascii=False), encoding='utf-8')
    if not (sd / 'decisions.json').exists():
        (sd / 'decisions.json').write_text(
            json.dumps({'batch': {}, 'groups': {}}), encoding='utf-8')


def _load_session_to_memory(job_id: str):
    """Load a saved session into the jobs dict (runs in background thread)."""
    try:
        if db.available():
            jobs[job_id].update({'pct': 20, 'message': 'Cargando desde base de datos…'})
            row = db.load_session(job_id)
            if not row:
                raise ValueError('Sesión no encontrada en la base de datos')
            jobs[job_id].update({'pct': 80, 'message': 'Reconstruyendo datos…'})
            jobs[job_id].update({
                'status':        'done',
                'pct':           100,
                'message':       '¡Listo!',
                'refs':          row['refs'],
                'groups':        row['groups_data'],
                'cats':          row['cats'],
                'response_cats': row['response_cats'],
                'total_refs':    row['total_refs'],
                'total_groups':  row['total_groups'],
                'mode_type':     row.get('mode', 'massive'),
            })
            return

        # Filesystem fallback
        sd = SESSIONS_DIR / job_id
        jobs[job_id].update({'pct': 10, 'message': 'Leyendo metadatos…'})
        meta = json.loads((sd / 'meta.json').read_text(encoding='utf-8'))
        jobs[job_id].update({'pct': 25, 'message': 'Cargando referencias…'})
        refs = json.loads((sd / 'refs.json').read_text(encoding='utf-8'))
        jobs[job_id].update({'pct': 65, 'message': 'Cargando grupos…'})
        groups = json.loads((sd / 'groups.json').read_text(encoding='utf-8'))
        jobs[job_id].update({'pct': 85, 'message': 'Reconstruyendo categorías…'})
        cats = json.loads((sd / 'cats.json').read_text(encoding='utf-8'))
        jobs[job_id].update({
            'status':        'done',
            'pct':           100,
            'message':       '¡Listo!',
            'refs':          refs,
            'groups':        groups,
            'cats':          cats,
            'response_cats': meta['response_cats'],
            'total_refs':    meta['total_refs'],
            'total_groups':  meta['total_groups'],
            'mode_type':     meta.get('mode', 'massive'),
        })
    except Exception as exc:
        jobs[job_id].update({'status': 'error', 'pct': 0, 'message': f'Error cargando sesión: {exc}'})


# ── Background job ────────────────────────────────────────────

def _process_job(job_id: str, file_contents: list[tuple[str, bytes]], config: dict,
                 session_name: str = ''):
    try:
        jobs[job_id].update({'status': 'processing', 'pct': 2, 'message': 'Parseando archivos…'})

        all_refs: list[dict] = []
        for name, content in file_contents:
            text = content.decode('utf-8', errors='replace')
            fmt  = detect_format(text)
            refs = parse_nbib(text, name) if fmt == 'nbib' else parse_ris(text, name)
            all_refs.extend(refs)

        jobs[job_id].update({'pct': 10, 'message': f'Deduplicando {len(all_refs):,} referencias…'})

        def progress_cb(pct: int, msg: str):
            jobs[job_id].update({'pct': 10 + int(pct * 0.85), 'message': msg})

        result = run_dedup(all_refs, opts=config, progress_cb=progress_cb)

        cats, response_cats = _build_cats(all_refs, result['groups'])

        jobs[job_id].update({
            'status':        'done',
            'pct':           100,
            'message':       '¡Listo!',
            'refs':          all_refs,
            'groups':        result['groups'],
            'cats':          cats,
            'response_cats': response_cats,
            'total_refs':    len(all_refs),
            'total_groups':  len(result['groups']),
            'session_name':  session_name,
            'mode_type':     'massive',
        })

        filenames = [name for name, _ in file_contents]
        _save_session(job_id, filenames)

    except Exception as exc:
        jobs[job_id].update({'status': 'error', 'pct': 0, 'message': str(exc)})


# ── API endpoints ─────────────────────────────────────────────

@app.get("/api/ping")
def ping():
    return {"status": "ok"}


@app.post("/api/upload")
async def upload(
    files:        list[UploadFile] = File(...),
    threshold:    float = Form(0.82),
    title_weight: float = Form(0.80),
    window_size:  int   = Form(80),
    mode:         str   = Form('both'),
    session_name: str   = Form(''),
):
    job_id        = uuid.uuid4().hex[:8]
    file_contents = [(f.filename or 'archivo.ris', await f.read()) for f in files]
    config = {
        'threshold':       threshold,
        'title_weight':    title_weight,
        'abstract_weight': round(1.0 - title_weight, 2),
        'window_size':     window_size,
        'mode':            mode,
    }
    jobs[job_id] = {
        'status':       'queued',
        'pct':          0,
        'message':      'En cola…',
        'created_at':   datetime.datetime.now().strftime('%d %b %Y, %H:%M'),
        'session_name': session_name,
    }
    t = threading.Thread(
        target=_process_job, args=(job_id, file_contents, config, session_name), daemon=True)
    t.start()
    return {'job_id': job_id}


@app.get("/api/progress/{job_id}")
def get_progress(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, 'Job no encontrado')
    return {'status': job['status'], 'pct': job['pct'], 'message': job['message']}


@app.get("/api/results/{job_id}")
def get_results(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, 'Job no encontrado')
    if job['status'] != 'done':
        raise HTTPException(400, 'El análisis no ha terminado')
    return {
        'total_refs':   job['total_refs'],
        'total_groups': job['total_groups'],
        'categories':   job['response_cats'],
    }


@app.get("/api/groups/{job_id}/{cat}")
def get_groups(job_id: str, cat: str, page: int = 0, per_page: int = 50):
    """Returns paginated groups for a given category with full ref details."""
    job = jobs.get(job_id)
    if not job or job['status'] != 'done':
        raise HTTPException(400, 'Job no listo')
    if cat not in ('doi', 'an', 'high', 'med', 'low'):
        raise HTTPException(404, 'Categoría inválida')

    all_refs = job['refs']
    groups   = job['groups']
    indices  = job['cats'][cat]['group_indices']

    total  = len(indices)
    start  = page * per_page
    slice_ = indices[start:start + per_page]

    def ref_detail(ref: dict) -> dict:
        return {
            'title':     ref.get('title') or '',
            'accession': ref.get('accession') or '',
            'authors':   (ref.get('authors') or '').split(';')[0].strip(),
            'year':      ref.get('year') or '',
            'source':    ref.get('_source') or '',
            'doi':       ref.get('doi') or '',
            'abstract':  (ref.get('abstract') or '')[:300],
        }

    return {
        'total':    total,
        'page':     page,
        'per_page': per_page,
        'groups': [
            {
                'group_index': gi,
                'max_score':   round(groups[gi]['max_score'], 3),
                'reason':      _primary_reason(groups[gi]),
                'members':     [ref_detail(all_refs[idx]) for idx in groups[gi]['members']],
            }
            for gi in slice_
        ],
    }


def _apply_group_confirm(gi: int, job: dict, keep_map: dict, csv_rows: list, cat: str):
    """Marks all but first member of group gi for removal and records CSV rows."""
    all_refs = job['refs']
    groups   = job['groups']
    group    = groups[gi]
    kept_idx = group['members'][0]
    kept_ref = all_refs[kept_idx]
    for idx in group['members'][1:]:
        keep_map[all_refs[idx]['id']] = False
        best = max(
            (p for p in group['pairs'] if p['i'] == idx or p['j'] == idx),
            key=lambda p: p['score'],
            default=None,
        )
        csv_rows.append({
            'grupo':             gi + 1,
            'AN_conservado':     kept_ref.get('accession') or '',
            'titulo_conservado': (kept_ref.get('title') or '')[:120],
            'fuente_conservada': kept_ref.get('_source') or '',
            'AN_duplicado':      all_refs[idx].get('accession') or '',
            'titulo_duplicado':  (all_refs[idx].get('title') or '')[:120],
            'fuente_duplicado':  all_refs[idx].get('_source') or '',
            'similitud_titulo':  f"{(best['title_sim'] * 100):.1f}%" if best else '',
            'similitud_resumen': f"{(best['abstr_sim'] * 100):.1f}%" if best else '',
            'score':             f"{(best['score'] * 100):.1f}%" if best else '',
            'categoria':         cat,
        })


@app.post("/api/export/{job_id}")
async def export_results(job_id: str, request: Request):
    """
    Body: {
      "batch":  { "doi": "confirm"|"skip", "an": "confirm"|"skip" },
      "groups": { "123": "confirm"|"skip", "456": "confirm", ... }
    }
    """
    job = jobs.get(job_id)
    if not job or job['status'] != 'done':
        raise HTTPException(400, 'Job no listo')

    body: dict    = await request.json()
    batch: dict   = body.get('batch',  {})
    grp_dec: dict = body.get('groups', {})

    all_refs: list[dict] = job['refs']
    cats:     dict       = job['cats']

    keep_map:  dict       = {r['id']: True for r in all_refs}
    csv_rows:  list[dict] = []

    for cat in ('doi', 'an'):
        if batch.get(cat) != 'confirm':
            continue
        for gi in cats[cat]['group_indices']:
            _apply_group_confirm(gi, job, keep_map, csv_rows, cat)

    for cat in ('high', 'med', 'low'):
        for gi in cats[cat]['group_indices']:
            if grp_dec.get(str(gi)) == 'confirm':
                _apply_group_confirm(gi, job, keep_map, csv_rows, cat)

    kept_refs = [r for r in all_refs if keep_map[r['id']]]

    tmp_dir  = Path(tempfile.gettempdir()) / f'dedup_{job_id}'
    tmp_dir.mkdir(exist_ok=True)

    ris_path = tmp_dir / 'deduplicado.ris'
    ris_path.write_text(refs_to_ris(kept_refs), encoding='utf-8')

    csv_path = tmp_dir / 'duplicados.csv'
    with open(csv_path, 'w', newline='', encoding='utf-8-sig') as f:
        if csv_rows:
            writer = csv.DictWriter(f, fieldnames=list(csv_rows[0].keys()))
            writer.writeheader()
            writer.writerows(csv_rows)
        else:
            f.write('Sin duplicados confirmados\n')

    job['export_dir'] = str(tmp_dir)

    return {
        'kept':    len(kept_refs),
        'removed': len(all_refs) - len(kept_refs),
        'pairs':   len(csv_rows),
    }


@app.get("/api/download/{job_id}/ris")
def download_ris(job_id: str):
    job = jobs.get(job_id)
    if not job or 'export_dir' not in job:
        raise HTTPException(400, 'Exportación no disponible — ejecuta /api/export primero')
    path = Path(job['export_dir']) / 'deduplicado.ris'
    return FileResponse(str(path), filename='referencias_deduplicadas.ris',
                        media_type='application/x-research-info-systems')


@app.get("/api/download/{job_id}/csv")
def download_csv(job_id: str):
    job = jobs.get(job_id)
    if not job or 'export_dir' not in job:
        raise HTTPException(400, 'Exportación no disponible — ejecuta /api/export primero')
    path = Path(job['export_dir']) / 'duplicados.csv'
    return FileResponse(str(path), filename='duplicados_confirmados.csv',
                        media_type='text/csv')


# ── Session endpoints ─────────────────────────────────────────

@app.get("/api/sessions")
def list_sessions():
    if db.available():
        rows   = db.list_sessions()
        result = []
        for row in rows:
            dec        = row.get('decisions') or {}
            total_refs = row.get('total_refs', 0) or 0
            epist_conf = dec.get('epist', {}).get('confirmed', [])
            removed    = sum(len(c.get('removedIds', [])) for c in epist_conf)
            result.append({
                'job_id':          row['job_id'],
                'name':            row.get('name') or ', '.join(row.get('filenames') or []),
                'mode':            row.get('mode', 'massive'),
                'created_at':      row.get('created_at', ''),
                'filenames':       row.get('filenames') or [],
                'total_refs':      total_refs,
                'refs_remaining':  max(0, total_refs - removed),
                'total_groups':    row.get('total_groups', 0),
                'response_cats':   row.get('response_cats') or {},
                'confirmed':       sum(1 for v in dec.get('groups', {}).values() if v == 'confirmed'),
                'skipped':         sum(1 for v in dec.get('groups', {}).values() if v == 'skipped'),
                'batch_confirmed': [k for k, v in dec.get('batch', {}).items() if v == 'confirmed'],
            })
        return result

    # Filesystem fallback
    result = []
    if not SESSIONS_DIR.exists():
        return result
    for sd in sorted(SESSIONS_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not sd.is_dir():
            continue
        meta_path = sd / 'meta.json'
        if not meta_path.exists():
            continue
        meta    = json.loads(meta_path.read_text(encoding='utf-8'))
        dec_path = sd / 'decisions.json'
        dec     = json.loads(dec_path.read_text(encoding='utf-8')) if dec_path.exists() else {'batch': {}, 'groups': {}}
        meta['confirmed']       = sum(1 for v in dec.get('groups', {}).values() if v == 'confirmed')
        meta['skipped']         = sum(1 for v in dec.get('groups', {}).values() if v == 'skipped')
        meta['batch_confirmed'] = [k for k, v in dec.get('batch', {}).items() if v == 'confirmed']
        result.append(meta)
    return result


@app.post("/api/sessions/{job_id}/load")
def load_session(job_id: str):
    """Start loading a saved session into memory (polls /api/progress/{job_id})."""
    if job_id in jobs and jobs[job_id].get('status') == 'done':
        return {
            'job_id': job_id,
            'already_loaded': True,
            'mode': jobs[job_id].get('mode_type', 'massive'),
        }

    # Determine mode from storage without loading full data
    mode = 'massive'
    if db.available():
        row = db.load_session(job_id)
        if not row:
            raise HTTPException(404, 'Sesión no encontrada')
        mode = row.get('mode', 'massive')
    else:
        sd = SESSIONS_DIR / job_id
        if not (sd / 'meta.json').exists():
            raise HTTPException(404, 'Sesión no encontrada')
        meta = json.loads((sd / 'meta.json').read_text(encoding='utf-8'))
        mode = meta.get('mode', 'massive')

    jobs[job_id] = {
        'status':    'loading',
        'pct':       0,
        'message':   'Iniciando carga…',
        'mode_type': mode,
    }
    t = threading.Thread(target=_load_session_to_memory, args=(job_id,), daemon=True)
    t.start()
    return {'job_id': job_id, 'already_loaded': False, 'mode': mode}


@app.get("/api/sessions/{job_id}/full")
def get_session_full(job_id: str):
    """Returns complete refs + groups for Epistemonikos session restore."""
    job = jobs.get(job_id)
    if not job or job['status'] != 'done':
        raise HTTPException(400, 'Job no listo')
    return {
        'refs':         job['refs'],
        'groups':       job['groups'],
        'total_refs':   job['total_refs'],
        'total_groups': job['total_groups'],
    }


@app.get("/api/sessions/{job_id}/decisions")
def get_session_decisions(job_id: str):
    if db.available():
        return db.get_decisions(job_id)
    dec_path = SESSIONS_DIR / job_id / 'decisions.json'
    if not dec_path.exists():
        return {'batch': {}, 'groups': {}}
    return json.loads(dec_path.read_text(encoding='utf-8'))


@app.post("/api/sessions/{job_id}/decisions")
async def save_session_decisions(job_id: str, request: Request):
    body = await request.json()
    if db.available():
        db.save_decisions(job_id, body)
        return {'ok': True}
    sd = SESSIONS_DIR / job_id
    if not sd.exists():
        raise HTTPException(404, 'Sesión no encontrada')
    (sd / 'decisions.json').write_text(json.dumps(body, ensure_ascii=False), encoding='utf-8')
    return {'ok': True}


@app.delete("/api/sessions/{job_id}")
def delete_session(job_id: str):
    if db.available():
        db.delete_session(job_id)
    else:
        sd = SESSIONS_DIR / job_id
        if sd.exists():
            shutil.rmtree(sd)
    if job_id in jobs:
        del jobs[job_id]
    return {'ok': True}


@app.post("/api/sessions/save")
async def save_client_session(request: Request):
    """
    Saves a client-side computed session (Epistemonikos mode).
    Body: { name, mode, filenames, refs, groups }
    Returns: { job_id, created_at }
    """
    body     = await request.json()
    job_id   = uuid.uuid4().hex[:8]
    all_refs = body.get('refs', [])
    groups   = body.get('groups', [])
    filenames = body.get('filenames', [])
    name      = body.get('name') or ', '.join(filenames) or 'Sin nombre'
    mode      = body.get('mode', 'epistemo')
    created_at = datetime.datetime.now().strftime('%d %b %Y, %H:%M')

    cats, response_cats = _build_cats(all_refs, groups)

    jobs[job_id] = {
        'status':        'done',
        'pct':           100,
        'message':       '¡Listo!',
        'refs':          all_refs,
        'groups':        groups,
        'cats':          cats,
        'response_cats': response_cats,
        'total_refs':    len(all_refs),
        'total_groups':  len(groups),
        'created_at':    created_at,
        'session_name':  name,
        'mode_type':     mode,
    }

    _save_session(job_id, filenames)
    return {'job_id': job_id, 'created_at': created_at}


# ── Serve static frontend ─────────────────────────────────────
# Must be last so API routes take precedence.
_static_dir = str(Path(__file__).parent.parent)
app.mount("/", StaticFiles(directory=_static_dir, html=True), name="static")


# ── Entry point ───────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn

    def _open_browser():
        import time
        time.sleep(1.5)
        webbrowser.open("http://localhost:8000")

    threading.Thread(target=_open_browser, daemon=True).start()

    print()
    print("  ✓  Deduplicador RIS — Backend Masivo")
    print("     Abre tu navegador en: http://localhost:8000")
    print("     (Ctrl+C para detener)\n")

    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
