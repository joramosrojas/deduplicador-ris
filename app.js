/* =========================================================
   DETECTOR DE DUPLICADOS RIS — app.js
   ========================================================= */

/* ==========================================================
   HOME SCREEN
   ========================================================== */

async function homeShow() {
  showSection('sec-home');
  const list = document.getElementById('home-sessions-list');
  list.innerHTML = '<div style="text-align:center;padding:60px;color:#94a3b8">Cargando sesiones…</div>';
  try {
    const res      = await fetch('/api/sessions');
    if (!res.ok) throw new Error('Backend no disponible');
    const sessions = await res.json();
    homeRender(sessions);
  } catch {
    list.innerHTML = `<div class="sessions-empty">
      <p style="font-weight:600">No se pudo cargar el listado</p>
      <p style="font-size:.85rem;color:#94a3b8;margin-top:4px">
        Asegúrate de que el backend esté corriendo, o inicia un nuevo análisis.
      </p>
    </div>`;
  }
}

function homeRender(sessions, filter = '') {
  const list = document.getElementById('home-sessions-list');
  const q    = filter.toLowerCase().trim();

  const visible = q
    ? sessions.filter(s => {
        const name  = (s.name || '').toLowerCase();
        const files = (s.filenames || []).join(' ').toLowerCase();
        return name.includes(q) || files.includes(q);
      })
    : sessions;

  if (!visible.length) {
    list.innerHTML = `<div class="sessions-empty">
      <p style="font-weight:600">${q ? 'Sin resultados para "' + filter + '"' : 'No hay sesiones guardadas'}</p>
      <p style="font-size:.85rem;color:#94a3b8;margin-top:4px">
        ${q ? 'Prueba con otro término.' : 'Sube archivos RIS para comenzar.'}
      </p>
    </div>`;
    return;
  }

  list.innerHTML = visible.map(s => _homeSessionCard(s)).join('');

  list.querySelectorAll('.home-btn-resume').forEach(btn =>
    btn.addEventListener('click', () => massiveResumeSession(btn.dataset.jobId))
  );
  list.querySelectorAll('.home-btn-delete').forEach(btn =>
    btn.addEventListener('click', () => homeDeleteSession(btn.dataset.jobId))
  );
}

function _homeSessionCard(s) {
  const mode      = s.mode || 'massive';
  const modeLabel = mode === 'epistemo' ? 'Epistemonikos' : 'Gran Escala';
  const modeCls   = mode === 'epistemo' ? 'mode-epistemo' : 'mode-massive';
  const total     = s.total_groups || 0;
  const done      = (s.confirmed || 0) + (s.skipped || 0);
  const pct       = total > 0 ? Math.round(done / total * 100) : 0;
  const files     = (s.filenames || []).join(', ') || 'Sin nombre';
  const name      = s.name || files;
  const totalRefs = s.total_refs || 0;
  const remaining = s.refs_remaining !== undefined ? s.refs_remaining : totalRefs;
  const refsLabel = remaining < totalRefs
    ? `${remaining.toLocaleString()} refs únicas (de ${totalRefs.toLocaleString()})`
    : `${totalRefs.toLocaleString()} refs`;

  return `<div class="session-card">
    <div class="session-card-info">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span class="home-session-mode ${modeCls}">${modeLabel}</span>
        <span class="session-card-file">${name}</span>
      </div>
      <div class="session-card-meta">${s.created_at || ''} · ${refsLabel} · ${total.toLocaleString()} grupos</div>
      <div class="session-card-progress">
        <div class="session-progress-bar"><div class="session-progress-fill" style="width:${pct}%"></div></div>
        <span class="session-progress-label">${done.toLocaleString()} revisados · <strong>${(total - done).toLocaleString()} pendientes</strong></span>
      </div>
    </div>
    <div class="session-card-actions">
      <button class="btn-primary home-btn-resume" data-job-id="${s.job_id}">Abrir →</button>
      <button class="btn-text home-btn-delete" data-job-id="${s.job_id}" style="color:#f87171;font-size:.8rem">Eliminar</button>
    </div>
  </div>`;
}

async function homeDeleteSession(jobId) {
  if (!confirm('¿Eliminar esta sesión? Se perderán las decisiones guardadas.')) return;
  await fetch(`/api/sessions/${jobId}`, { method: 'DELETE' });
  homeShow();
}

/* Home search wiring (called from DOMContentLoaded) */
function homeInitSearch(sessions) {
  const input = document.getElementById('home-search');
  if (!input) return;
  input.addEventListener('input', () => homeRender(sessions, input.value));
}

// Override homeShow to also wire search after load
async function homeShowFull() {
  showSection('sec-home');
  const list = document.getElementById('home-sessions-list');
  list.innerHTML = '<div style="text-align:center;padding:60px;color:#94a3b8">Cargando sesiones…</div>';
  const input = document.getElementById('home-search');
  if (input) input.value = '';

  try {
    const res      = await fetch('/api/sessions');
    if (!res.ok) throw new Error();
    const sessions = await res.json();
    homeRender(sessions);
    if (input) input.oninput = () => homeRender(sessions, input.value);
  } catch {
    list.innerHTML = `<div class="sessions-empty">
      <p style="font-weight:600">No se pudo conectar al backend</p>
      <p style="font-size:.85rem;color:#94a3b8;margin-top:4px">Asegúrate de que el servidor esté corriendo.</p>
    </div>`;
  }
}

const st = {
  files:       [],   // { name, refs[] }
  allRefs:     [],
  groups:      [],   // from runDedup
  visibleGroups: [], // after filter
  keepMap:     {},   // refId → true (keep) | false (remove)
  page:        0,
  perPage:     25,
  threshold:   0.82,
  titleWeight: 0.80,
  windowSize:  80,
  mode:        'both',  // 'id' | 'text' | 'both'
  filterDOI:   'all',   // 'all' | 'has' | 'no'
};

// ── Helpers ────────────────────────────────────────────────
function showSection(id) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

let _toastTimer;
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast ' + type;
  void t.offsetWidth; t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function fmtPct(v) { return Math.round(v * 100) + '%'; }

function scoreLabel(s, reason) {
  if (reason === 'doi')           return { label: 'DOI exacto',          cls: 'score-exact' };
  if (reason === 'an')            return { label: 'ID externo exacto',   cls: 'score-exact' };
  if (reason === 'title_abstract')return { label: 'Título + resumen: ' + fmtPct(s), cls: 'score-high' };
  if (reason === 'journal')       return { label: 'Revista: ' + fmtPct(s),          cls: 'score-med' };
  if (s >= 0.99) return { label: 'Exacto',              cls: 'score-exact' };
  if (s >= 0.90) return { label: 'Título: ' + fmtPct(s), cls: 'score-high' };
  if (s >= 0.75) return { label: 'Título: ' + fmtPct(s), cls: 'score-med' };
  return             { label: 'Título: ' + fmtPct(s), cls: 'score-low' };
}

function downloadFile(content, filename, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename; a.click(); URL.revokeObjectURL(a.href);
}

// ── File handling ──────────────────────────────────────────
function loadFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = e => resolve(e.target.result);
    r.onerror = () => reject(new Error('Error leyendo ' + file.name));
    r.readAsText(file, 'utf-8');
  });
}

function detectFormat(text) {
  // NBIB files start with "PMID-" on the first non-empty line
  const firstLine = text.trimStart().slice(0, 20);
  if (/^PMID-?\s/i.test(firstLine)) return 'nbib';
  return 'ris';
}

async function addFiles(fileList) {
  for (const file of fileList) {
    const nameLower = file.name.toLowerCase();
    if (!nameLower.endsWith('.ris') && !nameLower.endsWith('.nbib')) continue;
    if (st.files.find(f => f.name === file.name)) continue;
    try {
      const text = await loadFile(file);
      const fmt  = detectFormat(text);
      const refs = fmt === 'nbib' ? parseNBIB(text, file.name) : parseRIS(text, file.name);
      st.files.push({ name: file.name, count: refs.length, refs });
    } catch (e) {
      showToast('Error: ' + e.message, 'error');
    }
  }
  renderFileList();
}

function renderFileList() {
  const list = document.getElementById('file-list');
  const items = document.getElementById('file-items');
  const total = st.files.reduce((s, f) => s + f.count, 0);
  const btn   = document.getElementById('btn-run');

  if (!st.files.length) {
    list.style.display = 'none';
    btn.disabled = true;
    return;
  }
  list.style.display = '';
  btn.disabled = total === 0;

  items.innerHTML = st.files.map((f, i) => `
    <div class="file-item">
      <svg class="file-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span class="file-item-name" title="${f.name}">${f.name}</span>
      <span class="file-item-count">${f.count.toLocaleString()} refs</span>
      <button class="file-item-remove" data-idx="${i}" title="Quitar archivo">×</button>
    </div>`).join('');

  document.getElementById('file-total').textContent =
    `Total: ${total.toLocaleString()} referencias en ${st.files.length} archivo${st.files.length > 1 ? 's' : ''}`;

  items.querySelectorAll('.file-item-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      st.files.splice(+e.currentTarget.dataset.idx, 1);
      renderFileList();
    });
  });
}

// ── Settings ───────────────────────────────────────────────
function initSettings() {
  const tSlider  = document.getElementById('threshold-slider');
  const twSlider = document.getElementById('tw-slider');
  const winSlider = document.getElementById('win-slider');

  tSlider.addEventListener('input', () => {
    st.threshold = tSlider.value / 100;
    document.getElementById('threshold-val').textContent = tSlider.value + '%';
  });
  twSlider.addEventListener('input', () => {
    st.titleWeight = twSlider.value / 100;
    document.getElementById('tw-val').textContent = twSlider.value + '%';
  });
  winSlider.addEventListener('input', () => {
    st.windowSize = +winSlider.value;
    document.getElementById('win-val').textContent = winSlider.value + ' refs';
  });

  document.querySelectorAll('input[name="dedup-mode"]').forEach(radio => {
    radio.addEventListener('change', () => {
      st.mode = radio.value;
      // Show/hide text similarity settings based on mode
      const textOnly = st.mode !== 'id';
      document.getElementById('tw-slider').closest('.setting-row').style.display = textOnly ? '' : 'none';
      document.getElementById('win-slider').closest('.setting-row').style.display = textOnly ? '' : 'none';
      document.getElementById('threshold-slider').closest('.setting-row').style.display = textOnly ? '' : 'none';
    });
  });
}

// ── Run deduplication ──────────────────────────────────────
async function runAnalysis() {
  showSection('sec-processing');
  setProgress('Preparando referencias…', 10);
  await delay(30);

  // Merge all refs
  st.allRefs = st.files.flatMap(f => f.refs);
  setProgress(`Analizando ${st.allRefs.length.toLocaleString()} referencias…`, 30);
  await delay(30);

  // Run dedup in next tick (avoid UI freeze)
  const result = await new Promise(resolve => {
    setTimeout(() => {
      const r = runDedup(st.allRefs, {
        threshold:      st.threshold,
        titleWeight:    st.titleWeight,
        abstractWeight: 1 - st.titleWeight,
        windowSize:     st.windowSize,
        mode:           st.mode,
      });
      resolve(r);
    }, 20);
  });

  setProgress('Organizando resultados…', 85);
  await delay(30);

  st.groups = result.groups;

  // Default: keep first ref in each group, remove the rest
  st.keepMap = {};
  st.allRefs.forEach(r => { st.keepMap[r.id] = true; });
  st.groups.forEach(g => {
    g.members.slice(1).forEach(idx => {
      st.keepMap[st.allRefs[idx].id] = false;
    });
  });

  st.page = 0;
  applyFilter();
  updateHeaderStats();
  setProgress('¡Listo!', 100);
  await delay(200);

  showSection('sec-results');
}

function setProgress(msg, pct) {
  document.getElementById('proc-title').textContent = msg;
  document.getElementById('proc-bar').style.width = pct + '%';
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Filter & render ────────────────────────────────────────
function applyFilter() {
  const f = document.getElementById('filter-select').value;
  st.visibleGroups = st.groups.filter(g => {
    if (f === 'all')   return true;
    if (f === 'exact') return g.pairs.some(p => p.reason === 'doi') || g.maxScore >= 0.99;
    if (f === 'high')  return g.maxScore >= 0.90;
    if (f === 'med')   return g.maxScore >= 0.75 && g.maxScore < 0.90;
    if (f === 'low')   return g.maxScore < 0.75;
    return true;
  });
  if (st.filterDOI !== 'all') {
    st.visibleGroups = st.visibleGroups.filter(g => {
      const hasDOI = g.members.some(idx => st.allRefs[idx]?.doi);
      return st.filterDOI === 'has' ? hasDOI : !hasDOI;
    });
  }
  st.page = 0;
  renderResults();
}

function renderResults() {
  renderToolbar();
  renderGroups();
  renderPagination();
  renderBanner();
}

function renderToolbar() {
  const total   = st.allRefs.length;
  const dupRefs = st.groups.flatMap(g => g.members).length;
  const toRemove = Object.values(st.keepMap).filter(v => !v).length;
  const toKeep   = total - toRemove;

  document.getElementById('results-stats').innerHTML = `
    <span class="stat-chip chip-total">${total.toLocaleString()} refs totales</span>
    <span class="stat-chip chip-groups">${st.groups.length} grupos · ${dupRefs} referencias</span>
    <span class="stat-chip chip-remove">−${toRemove.toLocaleString()} a eliminar</span>
    <span class="stat-chip chip-keep">${toKeep.toLocaleString()} a conservar</span>
  `;
}

function renderBanner() {
  const toRemove = Object.values(st.keepMap).filter(v => !v).length;
  const banner = document.getElementById('remove-banner');
  if (toRemove > 0) {
    banner.textContent = `${toRemove.toLocaleString()} referencia${toRemove > 1 ? 's' : ''} marcada${toRemove > 1 ? 's' : ''} para eliminar. Descarga el RIS limpio con el botón "Exportar".`;
    banner.classList.add('visible');
  } else {
    banner.classList.remove('visible');
  }
}

function renderGroups() {
  const wrap  = document.getElementById('groups-wrap');
  const start = st.page * st.perPage;
  const slice = st.visibleGroups.slice(start, start + st.perPage);

  if (!slice.length) {
    wrap.innerHTML = `<div style="text-align:center;padding:60px;color:#94a3b8">
      <p style="font-size:1rem;font-weight:600">No se encontraron grupos con este filtro</p>
    </div>`;
    return;
  }

  wrap.innerHTML = slice.map((g, gi) => {
    const globalIdx = start + gi;
    const topReason = g.pairs.length ? g.pairs[0].reason : '';
    const sl = scoreLabel(g.maxScore, topReason);
    const firstRef = st.allRefs[g.members[0]];
    const preview  = (firstRef?.title || '').slice(0, 100);

    const refsHtml = g.members.map(idx => {
      const r      = st.allRefs[idx];
      const keep   = st.keepMap[r.id] !== false;
      const rowCls = keep ? 'keep' : 'remove';
      const icon   = keep ? '✓' : '✕';
      const meta   = [r.authors?.split(';')[0]?.trim(), r.year, r.journal]
                       .filter(Boolean).join(' · ');

      // Find best sim score for this ref within the group
      const bestPair = g.pairs.reduce((best, p) => {
        if ((p.i === idx || p.j === idx) && p.score > (best?.score || 0)) return p;
        return best;
      }, null);
      const simBadge = bestPair
        ? `<span class="ref-sim-badge">${fmtPct(bestPair.titleSim)} título${bestPair.abstrSim > 0 ? ' · ' + fmtPct(bestPair.abstrSim) + ' resumen' : ''}</span>`
        : '';

      const sourceBadge = r._source
        ? `<span class="ref-source-badge">${r._source}</span>`
        : '';

      return `<div class="ref-row ${rowCls}" data-id="${r.id}" data-group="${globalIdx}">
        <button class="ref-decision-btn" data-id="${r.id}" title="${keep ? 'Clic para marcar esta referencia como duplicado a eliminar' : 'Clic para conservar esta referencia y no eliminarla'}">${icon}</button>
        <div class="ref-body">
          <div class="ref-title">${r.title || '(sin título)'}</div>
          ${meta ? `<div class="ref-meta">${meta}</div>` : ''}
          ${r.doi ? `<div class="ref-meta">DOI: ${r.doi}</div>` : ''}
          ${r.accession ? `<div class="ref-meta ref-an">AN: <a class="epist-an-link" href="https://www.epistemonikos.org/documents/${r.accession}" target="_blank" rel="noopener">${r.accession}</a></div>` : ''}
          ${r.abstract ? `<div class="ref-abstract">${r.abstract}</div>` : ''}
        </div>
        ${sourceBadge}
        ${simBadge}
      </div>`;
    }).join('');

    return `<div class="dup-group" id="grp-${globalIdx}">
      <div class="group-header" data-grp="${globalIdx}">
        <span class="group-toggle">▾</span>
        <span class="group-score-badge ${sl.cls}">${sl.label}</span>
        <span class="group-title-preview">${preview}</span>
        <span class="group-count">${g.members.length} refs</span>
        <div class="group-actions" onclick="event.stopPropagation()">
          <button class="btn-group-keep"   data-grp="${globalIdx}" title="Marca la primera referencia del grupo para conservar y el resto para eliminar.">Conservar primera</button>
          <button class="btn-group-remove" data-grp="${globalIdx}" title="Marca la primera referencia para conservar y elimina todas las demás del grupo.">Eliminar todas menos primera</button>
        </div>
      </div>
      <div class="group-refs" id="grp-refs-${globalIdx}">${refsHtml}</div>
    </div>`;
  }).join('');

  // Events: toggle group
  wrap.querySelectorAll('.group-header').forEach(h => {
    h.addEventListener('click', () => {
      const refs = document.getElementById('grp-refs-' + h.dataset.grp);
      const tog  = h.querySelector('.group-toggle');
      const open = refs.style.display !== 'none';
      refs.style.display = open ? 'none' : '';
      tog.textContent = open ? '▸' : '▾';
    });
  });

  // Events: toggle per-ref decision
  wrap.querySelectorAll('.ref-decision-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.id;
      st.keepMap[id] = !st.keepMap[id];
      renderResults();
    });
  });

  // Events: group-level keep/remove
  wrap.querySelectorAll('.btn-group-keep').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const g = st.visibleGroups[+btn.dataset.grp - st.page * st.perPage + st.page * st.perPage];
      // keep first, remove rest
      const grp = st.visibleGroups[btn.dataset.grp];
      grp.members.forEach((idx, i) => {
        st.keepMap[st.allRefs[idx].id] = i === 0;
      });
      renderResults();
    });
  });
  wrap.querySelectorAll('.btn-group-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const grp = st.visibleGroups[btn.dataset.grp];
      grp.members.forEach((idx, i) => {
        st.keepMap[st.allRefs[idx].id] = i === 0;
      });
      renderResults();
    });
  });
}

function renderPagination() {
  const total = Math.ceil(st.visibleGroups.length / st.perPage);
  const pg    = document.getElementById('pagination');
  if (total <= 1) { pg.innerHTML = ''; return; }

  let html = `<button class="page-btn" ${st.page === 0 ? 'disabled' : ''} data-p="${st.page - 1}">← Anterior</button>`;
  const start = Math.max(0, st.page - 3);
  const end   = Math.min(total, st.page + 4);
  if (start > 0)     html += `<button class="page-btn" data-p="0">1</button><span>…</span>`;
  for (let i = start; i < end; i++) {
    html += `<button class="page-btn${i === st.page ? ' active' : ''}" data-p="${i}">${i + 1}</button>`;
  }
  if (end < total)   html += `<span>…</span><button class="page-btn" data-p="${total - 1}">${total}</button>`;
  html += `<button class="page-btn" ${st.page >= total - 1 ? 'disabled' : ''} data-p="${st.page + 1}">Siguiente →</button>`;
  html += `<span style="font-size:.78rem;color:#64748b;margin-left:6px">Página ${st.page + 1} de ${total} · ${st.visibleGroups.length} grupos</span>`;

  pg.innerHTML = html;
  pg.querySelectorAll('.page-btn:not(:disabled)').forEach(btn => {
    btn.addEventListener('click', () => {
      st.page = +btn.dataset.p;
      renderGroups();
      renderPagination();
      document.getElementById('groups-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function updateHeaderStats() {
  const el  = document.getElementById('header-stats');
  const tot = document.getElementById('hstat-total');
  const dup = document.getElementById('hstat-dups');
  el.style.display = '';
  tot.textContent = st.allRefs.length.toLocaleString() + ' referencias';
  dup.textContent = st.groups.length + ' grupos de duplicados';
}

// ── Keep first all ──────────────────────────────────────────
function keepFirstAll() {
  st.allRefs.forEach(r => { st.keepMap[r.id] = true; });
  st.groups.forEach(g => {
    g.members.slice(1).forEach(idx => {
      st.keepMap[st.allRefs[idx].id] = false;
    });
  });
  renderResults();
  showToast('Primera referencia conservada en cada grupo', 'success');
}

// ── Export ──────────────────────────────────────────────────
function exportRIS() {
  const kept = st.allRefs.filter(r => st.keepMap[r.id] !== false);
  if (!kept.length) { showToast('No hay referencias para exportar', 'error'); return; }
  const ris = refsToRIS(kept);
  downloadFile(ris, 'referencias_deduplicadas.ris', 'application/x-research-info-systems');
  showToast(`${kept.length.toLocaleString()} referencias exportadas`, 'success');
}

function exportCSV() {
  const escape = v => `"${String(v || '').replace(/"/g, '""')}"`;
  const headers = [
    'grupo',
    'ref_conservada_AN', 'ref_conservada_titulo', 'ref_conservada_fuente',
    'ref_eliminada_AN',  'ref_eliminada_titulo',  'ref_eliminada_fuente',
    'similitud_titulo', 'similitud_resumen', 'score_total', 'motivo',
  ];
  const rows = [];

  st.groups.forEach((g, gi) => {
    // Collect all unique confirmed-duplicate pairs in this group:
    // a "confirmed" pair = one ref is kept, the other is marked remove
    const seen = new Set();
    g.pairs.forEach(p => {
      const a = st.allRefs[p.i], b = st.allRefs[p.j];
      if (!a || !b) return;
      const aKept = st.keepMap[a.id] !== false;
      const bKept = st.keepMap[b.id] !== false;
      // Only include pairs where exactly one is removed (confirmed duplicate)
      if (aKept === bKept) return;
      const [kept, removed] = aKept ? [a, b] : [b, a];
      const pairKey = `${kept.id}|${removed.id}`;
      if (seen.has(pairKey)) return;
      seen.add(pairKey);
      rows.push([
        gi + 1,
        kept.accession    || '', kept.title    || '', kept._source    || '',
        removed.accession || '', removed.title || '', removed._source || '',
        (p.titleSim * 100).toFixed(1) + '%',
        (p.abstrSim * 100).toFixed(1) + '%',
        (p.score    * 100).toFixed(1) + '%',
        p.reason,
      ]);
    });
  });

  if (!rows.length) {
    showToast('No hay duplicados confirmados aún. Marca referencias para eliminar primero.', 'error');
    return;
  }

  const csv = [headers.map(escape).join(','),
    ...rows.map(r => r.map(escape).join(','))].join('\n');
  downloadFile('\ufeff' + csv, 'duplicados_confirmados.csv', 'text/csv;charset=utf-8');
  showToast(`${rows.length} par${rows.length > 1 ? 'es' : ''} de duplicados exportado${rows.length > 1 ? 's' : ''}`, 'success');
}

/* ==========================================================
   EPISTEMONIKOS MODE
   ========================================================== */

const ep = {
  files:        [],
  allRefs:      [],
  groups:       [],
  confirmed:    [],        // { kept: ref, removed: ref[], reason }
  discarded:    new Set(), // group indices discarded by user
  page:         0, perPage: 20,
  threshold:    0.82,
  titleWeight:  0.80,
  windowSize:   80,
  mode:         'both',
  activeCategory:    'all',  // 'all'|'doi'|'an'|'title_combined'|'journal'
  filterDOI:   'all',   // 'all' | 'same' | 'distinct' | 'none'
  filterMatch: 'all',   // 'all' | 'title_abstract' | 'title'
};

function epistemShowSection(id) {
  // Only switch within epistemonikos sections
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── File handling ───────────────────────────────────────────
async function epistAddFiles(fileList) {
  for (const file of fileList) {
    const nameLower = file.name.toLowerCase();
    if (!nameLower.endsWith('.ris') && !nameLower.endsWith('.nbib')) continue;
    if (ep.files.find(f => f.name === file.name)) continue;
    try {
      const text = await loadFile(file);
      const fmt  = detectFormat(text);
      const refs = fmt === 'nbib' ? parseNBIB(text, file.name) : parseRIS(text, file.name);
      ep.files.push({ name: file.name, count: refs.length, refs });
    } catch (e) {
      showToast('Error: ' + e.message, 'error');
    }
  }
  epistRenderFileList();
}

function epistRenderFileList() {
  const list  = document.getElementById('epist-file-list');
  const items = document.getElementById('epist-file-items');
  const total = ep.files.reduce((s, f) => s + f.count, 0);
  const btn   = document.getElementById('epist-btn-run');

  if (!ep.files.length) { list.style.display = 'none'; btn.disabled = true; return; }
  list.style.display = '';
  btn.disabled = total === 0;

  items.innerHTML = ep.files.map((f, i) => `
    <div class="file-item">
      <svg class="file-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span class="file-item-name" title="${f.name}">${f.name}</span>
      <span class="file-item-count">${f.count.toLocaleString()} refs</span>
      <button class="file-item-remove" data-idx="${i}" title="Quitar archivo">×</button>
    </div>`).join('');

  document.getElementById('epist-file-total').textContent =
    `Total: ${total.toLocaleString()} referencias en ${ep.files.length} archivo${ep.files.length > 1 ? 's' : ''}`;

  items.querySelectorAll('.file-item-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      ep.files.splice(+e.currentTarget.dataset.idx, 1);
      epistRenderFileList();
    });
  });
}

// ── Run ─────────────────────────────────────────────────────
async function epistRunAnalysis() {
  epistemShowSection('sec-processing');
  setProgress('Preparando referencias…', 10);
  await delay(30);

  ep.allRefs = ep.files.flatMap(f => f.refs);
  setProgress(`Analizando ${ep.allRefs.length.toLocaleString()} referencias…`, 35);
  await delay(30);

  const result = await new Promise(resolve => {
    setTimeout(() => resolve(runDedup(ep.allRefs, {
      threshold:      ep.threshold,
      titleWeight:    ep.titleWeight,
      abstractWeight: 1 - ep.titleWeight,
      windowSize:     ep.windowSize,
      mode:           ep.mode,
    })), 20);
  });

  setProgress('Organizando resultados…', 85);
  await delay(30);

  ep.groups    = result.groups;
  ep.confirmed = [];
  ep.discarded = new Set();
  ep.page      = 0;
  _epistSel.clear();

  epistRenderResults();
  setProgress('¡Listo!', 100);
  await delay(200);
  epistemShowSection('sec-epist-results');

  // Auto-save to backend when analysis finishes
  epistemSaveToBackend();
}

// ── Render results ──────────────────────────────────────────
// Primary reason for a group = highest-priority reason among its pairs
const REASON_PRIORITY = { doi: 0, an: 1, title_abstract: 2, title: 3, journal: 4 };
function groupPrimaryReason(g) {
  let best = null;
  for (const p of g.pairs) {
    if (best === null || (REASON_PRIORITY[p.reason] ?? 99) < (REASON_PRIORITY[best] ?? 99))
      best = p.reason;
  }
  return best || 'title';
}

function epistRenderResults() {
  epistRenderStats();
  epistRenderCategoryTabs();
  epistRenderConfirmedBar();
  epistRenderConfirmedTable();
  epistRenderPending();
}

function groupMatchesCat(g, cat) {
  const r = groupPrimaryReason(g);
  if (cat === 'title_combined') return r === 'title' || r === 'title_abstract';
  return r === cat;
}

function groupHasDistinctDOIs(g) {
  const dois = g.members
    .map(idx => ep.allRefs[idx]?.doi?.trim().toLowerCase())
    .filter(Boolean);
  if (dois.length < 2) return false;
  return new Set(dois).size > 1;
}

function epistRenderCategoryTabs() {
  const cats = ['all','doi','an','title_combined','journal'];
  const pending = ep.groups.filter((_, i) =>
    !ep.discarded.has(i) && !ep.confirmed.some(c =>
      ep.groups[i].members.includes(ep.allRefs.indexOf(c.kept))
    )
  );

  const counts = { all: pending.length, doi: 0, an: 0, title_combined: 0, journal: 0 };
  pending.forEach(g => {
    const r = groupPrimaryReason(g);
    if (r === 'doi')   counts.doi++;
    else if (r === 'an') counts.an++;
    else if (r === 'title' || r === 'title_abstract') counts.title_combined++;
    else if (r === 'journal') counts.journal++;
  });

  cats.forEach(cat => {
    const el = document.getElementById('cnt-' + cat);
    if (el) el.textContent = counts[cat] ?? 0;
  });

  document.querySelectorAll('.epist-cat-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.cat === ep.activeCategory);
  });

  // DOI pills always visible; match filter only for title_combined
  const matchGroup   = document.getElementById('epist-match-filter-group');
  const matchDivider = document.getElementById('epist-match-divider');
  if (matchGroup)   matchGroup.style.display   = ep.activeCategory === 'title_combined' ? '' : 'none';
  if (matchDivider) matchDivider.style.display = ep.activeCategory === 'title_combined' ? '' : 'none';
}

function epistRenderStats() {
  const total    = ep.allRefs.length;
  const inGroups = ep.groups.flatMap(g => g.members).length;
  const confirmed = ep.confirmed.length;
  const toRemove  = ep.confirmed.reduce((s, c) => s + c.removed.length, 0);
  document.getElementById('epist-results-stats').innerHTML = `
    <span class="stat-chip chip-total">${total.toLocaleString()} refs totales</span>
    <span class="stat-chip chip-groups">${ep.groups.length} grupos detectados</span>
    <span class="stat-chip chip-keep">${confirmed} confirmados</span>
    <span class="stat-chip chip-remove">−${toRemove} a eliminar</span>
  `;
}

function epistRenderConfirmedBar() {
  const bar = document.getElementById('epist-confirmed-bar');
  const cnt = document.getElementById('epist-confirmed-count');
  cnt.textContent = ep.confirmed.length;
  bar.style.display = ep.confirmed.length ? 'flex' : 'none';
}

function epistRenderConfirmedTable() {
  const sec   = document.getElementById('epist-confirmed-section');
  const wrap  = document.getElementById('epist-confirmed-table');
  if (!ep.confirmed.length) { sec.style.display = 'none'; return; }
  sec.style.display = '';

  const rows = ep.confirmed.map((c, i) => {
    const removedANs = c.removed.map(r =>
      r.accession
        ? `<a class="epist-an-chip" href="https://www.epistemonikos.org/documents/${r.accession}" target="_blank" rel="noopener">${r.accession}</a>`
        : `<span class="epist-an-chip">—</span>`
    ).join(' ');
    const removedTitles = c.removed.map(r =>
      `<div style="font-size:.78rem;color:#64748b">${r.title || '(sin título)'}<br><span style="font-size:.72rem">${r._source || ''}</span></div>`).join('');

    return `<tr>
      <td style="color:#94a3b8;font-size:.78rem">${i + 1}</td>
      <td>
        ${c.kept.accession
          ? `<a class="epist-an-chip epist-an-main" href="https://www.epistemonikos.org/documents/${c.kept.accession}" target="_blank" rel="noopener">${c.kept.accession}</a>`
          : `<span class="epist-an-chip epist-an-main">—</span>`}<br>
        <span style="font-size:.78rem">${c.kept._source || ''}</span>
      </td>
      <td style="font-size:.82rem;max-width:320px">${c.kept.title || '(sin título)'}</td>
      <td>${removedANs}<br>${removedTitles}</td>
      <td>
        <button class="btn-text" style="color:#dc2626;font-size:.75rem" data-undo="${i}">Deshacer</button>
      </td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<table class="epist-table">
    <thead><tr>
      <th>#</th>
      <th>AN conservado</th>
      <th>Título</th>
      <th>AN(s) duplicado(s)</th>
      <th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;

  wrap.querySelectorAll('[data-undo]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = +btn.dataset.undo;
      const [c] = ep.confirmed.splice(idx, 1);
      // Restore to pending
      const origGroupIdx = ep.groups.findIndex(g => g.members[0] === ep.allRefs.indexOf(c.kept));
      if (origGroupIdx >= 0) {
        ep.discarded.delete(origGroupIdx);
        ep.pending = ep.groups
          .map((_, i) => i)
          .filter(i => !ep.discarded.has(i) && !ep.confirmed.some(
            cc => ep.groups[i].members[0] === ep.allRefs.indexOf(cc.kept)
          ));
      }
      epistRenderResults();
    });
  });
}

// In-memory selection state per group card: { keepIdx, checkedIdxs: Set }
const _epistSel = new Map(); // groupIdx → { keepIdx, checkedIdxs }

function epistGetSel(grpIdx, members) {
  if (!_epistSel.has(grpIdx)) {
    _epistSel.set(grpIdx, {
      keepIdx:     members[0],
      checkedIdxs: new Set(members.slice(1)),
    });
  }
  return _epistSel.get(grpIdx);
}

function epistRenderPending() {
  const pendingGroups = ep.groups
    .map((g, i) => ({ g, i }))
    .filter(({ g, i }) => {
      if (ep.discarded.has(i)) return false;
      if (ep.confirmed.some(c => ep.groups[i].members.includes(ep.allRefs.indexOf(c.kept)))) return false;
      if (ep.activeCategory !== 'all' && !groupMatchesCat(g, ep.activeCategory)) return false;
      // DOI filter — applies to all categories
      if (ep.filterDOI !== 'all') {
        const dois = g.members.map(idx => ep.allRefs[idx]?.doi?.trim().toLowerCase()).filter(Boolean);
        const allSameDOI  = dois.length >= 2 && new Set(dois).size === 1;
        const hasDistinct = dois.length >= 2 && new Set(dois).size > 1;
        const noDOI       = dois.length === 0;
        if (ep.filterDOI === 'same'     && !allSameDOI)  return false;
        if (ep.filterDOI === 'distinct' && !hasDistinct) return false;
        if (ep.filterDOI === 'none'     && !noDOI)       return false;
      }
      // Match filter — only for title_combined
      if (ep.activeCategory === 'title_combined') {
        if (ep.filterMatch !== 'all' && groupPrimaryReason(g) !== ep.filterMatch) return false;
      }
      return true;
    });

  document.getElementById('epist-pending-title').textContent =
    `Grupos pendientes de revisión (${pendingGroups.length})`;

  const start = ep.page * ep.perPage;
  const slice = pendingGroups.slice(start, start + ep.perPage);
  const wrap  = document.getElementById('epist-groups-list');

  if (!slice.length) {
    wrap.innerHTML = `<div style="text-align:center;padding:48px;color:#94a3b8">
      <p style="font-weight:600">No hay grupos pendientes</p>
      <p style="font-size:.83rem;margin-top:4px">Todos los grupos han sido revisados</p>
    </div>`;
    document.getElementById('epist-pagination').innerHTML = '';
    return;
  }

  wrap.innerHTML = slice.map(({ g, i }) => {
    const sel     = epistGetSel(i, g.members);
    const reason  = groupPrimaryReason(g);
    const sl      = scoreLabel(g.maxScore, reason);
    const hasMany = g.members.length > 2;

    const refsHtml = g.members.map((idx) => {
      const r       = ep.allRefs[idx];
      const isKeep  = sel.keepIdx === idx;
      const isCheck = sel.checkedIdxs.has(idx);
      const meta    = [r.year, r.journal].filter(Boolean).join(' · ');
      const authors = r.authors?.split(';')[0]?.trim() || '';

      return `<div class="epist-ref-row${isKeep ? ' epist-row-keep' : isCheck ? ' epist-row-dup' : ' epist-row-neutral'}" data-grp="${i}" data-idx="${idx}">
        <div class="epist-ref-controls">
          <label class="epist-radio-wrap" title="Conservar esta referencia">
            <input type="radio" name="keep-${i}" value="${idx}" ${isKeep ? 'checked' : ''}/>
            <span class="epist-radio-label">Conservar</span>
          </label>
          ${!isKeep ? `<label class="epist-check-wrap" title="Marcar como duplicado">
            <input type="checkbox" data-grp="${i}" data-idx="${idx}" ${isCheck ? 'checked' : ''}/>
            <span class="epist-check-label">Duplicado</span>
          </label>` : '<span class="epist-keep-badge">✓ Conservar</span>'}
        </div>
        <div class="epist-ref-info">
          <div class="epist-ref-title">${r.title || '(sin título)'}</div>
          <div class="epist-ref-meta">
            ${r.accession ? `<strong>AN:</strong> <a class="epist-an-link" href="https://www.epistemonikos.org/documents/${r.accession}" target="_blank" rel="noopener">${r.accession}</a>` : '<em style="color:#94a3b8">Sin AN</em>'}
            ${authors ? ' · ' + authors : ''}
            ${meta ? ' · ' + meta : ''}
            ${r._source ? ` · <span style="color:#0369a1">${r._source}</span>` : ''}
          </div>
          ${r.doi ? `<div class="epist-ref-meta" style="font-size:.74rem">DOI: ${r.doi}</div>` : ''}
          ${r.abstract ? `
          <div class="epist-abstract-wrap">
            <button class="epist-abstract-toggle" data-abs="${idx}">Ver resumen ▾</button>
            <div class="epist-abstract-body" id="abs-${idx}" style="display:none">${r.abstract}</div>
          </div>` : ''}
        </div>
      </div>`;
    }).join('');

    const nDups = sel.checkedIdxs.size;
    const confirmDisabled = nDups === 0 ? 'disabled' : '';
    const confirmLabel    = nDups === 0
      ? 'Selecciona al menos un duplicado'
      : `Confirmar ${nDups} duplicado${nDups > 1 ? 's' : ''} ✓`;

    return `<div class="epist-group-card" data-grp="${i}">
      <div class="epist-group-header">
        <span class="group-score-badge ${sl.cls}">${sl.label}</span>
        <span class="group-title-preview">${ep.allRefs[g.members[0]]?.title || ''}</span>
        <span class="group-count">${g.members.length} refs</span>
      </div>
      ${hasMany ? `<div class="epist-group-hint">Selecciona cuál conservar y marca los duplicados</div>` : ''}
      <div class="epist-group-body">${refsHtml}</div>
      <div class="epist-group-actions">
        <button class="btn-epist-discard" data-grp="${i}" title="Descarta este grupo: ninguna de estas referencias es duplicada de otra. El grupo desaparece de la lista pendiente sin registrar ninguna eliminación.">Sin duplicados</button>
        <button class="btn-epist-confirm" data-grp="${i}" ${confirmDisabled} title="Registra la decisión: conserva la referencia marcada con 'Conservar' y marca las seleccionadas como 'Duplicado' para eliminar. La decisión queda en la tabla de confirmados.">${confirmLabel}</button>
      </div>
    </div>`;
  }).join('');

  // Abstract toggles
  wrap.querySelectorAll('.epist-abstract-toggle').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const body = document.getElementById('abs-' + btn.dataset.abs);
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      btn.textContent = open ? 'Ver resumen ▾' : 'Ocultar resumen ▴';
    });
  });

  // Radio: change which ref to keep
  wrap.querySelectorAll('input[type="radio"]').forEach(radio => {
    radio.addEventListener('change', () => {
      const grpIdx = +radio.name.replace('keep-', '');
      const refIdx = +radio.value;
      const sel    = _epistSel.get(grpIdx);
      // If previously kept was checked as dup, remove it; add old keep as dup if not already
      sel.checkedIdxs.delete(refIdx);
      if (sel.keepIdx !== refIdx) sel.checkedIdxs.add(sel.keepIdx);
      sel.keepIdx = refIdx;
      epistRenderPending();
    });
  });

  // Checkbox: toggle duplicate selection
  wrap.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const grpIdx = +cb.dataset.grp;
      const refIdx = +cb.dataset.idx;
      const sel    = _epistSel.get(grpIdx);
      if (cb.checked) sel.checkedIdxs.add(refIdx);
      else            sel.checkedIdxs.delete(refIdx);
      // Re-render just the action bar label without full re-render
      const card    = wrap.querySelector(`[data-grp="${grpIdx}"].epist-group-card`);
      const btn     = card?.querySelector('.btn-epist-confirm');
      if (btn) {
        const n = sel.checkedIdxs.size;
        btn.disabled = n === 0;
        btn.textContent = n === 0
          ? 'Selecciona al menos un duplicado'
          : `Confirmar ${n} duplicado${n > 1 ? 's' : ''} ✓`;
      }
    });
  });

  // Confirm
  wrap.querySelectorAll('.btn-epist-confirm').forEach(btn => {
    btn.addEventListener('click', () => {
      const i   = +btn.dataset.grp;
      const g   = ep.groups[i];
      const sel = _epistSel.get(i);
      if (!sel || sel.checkedIdxs.size === 0) return;

      ep.confirmed.push({
        kept:    ep.allRefs[sel.keepIdx],
        removed: [...sel.checkedIdxs].map(idx => ep.allRefs[idx]),
        reason:  groupPrimaryReason(g),
      });
      _epistSel.delete(i);
      ep.discarded.add(i);
      epistemSaveDecisions();

      // If there are unchecked non-kept refs, they become a new mini-group? No — just discard the whole group.
      ep.page = Math.max(0, Math.min(ep.page,
        Math.ceil((pendingGroups.length - 1) / ep.perPage) - 1));
      epistRenderResults();
      showToast('Duplicado confirmado', 'success');
    });
  });

  // Discard
  wrap.querySelectorAll('.btn-epist-discard').forEach(btn => {
    btn.addEventListener('click', () => {
      _epistSel.delete(+btn.dataset.grp);
      ep.discarded.add(+btn.dataset.grp);
      epistemSaveDecisions();
      epistRenderResults();
    });
  });

  // Pagination
  const totalPages = Math.ceil(pendingGroups.length / ep.perPage);
  const pg = document.getElementById('epist-pagination');
  if (totalPages <= 1) { pg.innerHTML = ''; return; }

  let html = `<button class="page-btn" ${ep.page === 0 ? 'disabled' : ''} data-p="${ep.page - 1}">← Anterior</button>`;
  for (let p = 0; p < totalPages; p++) {
    html += `<button class="page-btn${p === ep.page ? ' active' : ''}" data-p="${p}">${p + 1}</button>`;
  }
  html += `<button class="page-btn" ${ep.page >= totalPages - 1 ? 'disabled' : ''} data-p="${ep.page + 1}">Siguiente →</button>`;
  pg.innerHTML = html;
  pg.querySelectorAll('.page-btn:not(:disabled)').forEach(b => {
    b.addEventListener('click', () => { ep.page = +b.dataset.p; epistRenderPending(); });
  });
}

// ── Confirm all ─────────────────────────────────────────────
function epistConfirmAll() {
  ep.groups.forEach((g, i) => {
    if (ep.discarded.has(i)) return;
    if (ep.confirmed.some(c => ep.groups[i].members.includes(ep.allRefs.indexOf(c.kept)))) return;
    ep.confirmed.push({
      kept:    ep.allRefs[g.members[0]],
      removed: g.members.slice(1).map(idx => ep.allRefs[idx]),
      reason:  g.pairs[0]?.reason || 'an',
    });
    ep.discarded.add(i);
  });
  ep.page = 0;
  epistRenderResults();
  showToast(`${ep.confirmed.length} conjuntos confirmados`, 'success');
}

// ── Export ──────────────────────────────────────────────────
function epistExportRIS() {
  const removedIds = new Set(
    ep.confirmed.flatMap(c => c.removed.map(r => r.id))
  );
  const kept = ep.allRefs.filter(r => !removedIds.has(r.id));
  if (!kept.length) { showToast('No hay referencias para exportar', 'error'); return; }
  downloadFile(refsToRIS(kept), 'epistemonikos_deduplicado.ris', 'application/x-research-info-systems');
  showToast(`${kept.length.toLocaleString()} referencias exportadas`, 'success');
}

function epistExportCSV() {
  if (!ep.confirmed.length) {
    showToast('No hay conjuntos confirmados aún', 'error'); return;
  }
  const escape = v => `"${String(v || '').replace(/"/g, '""')}"`;
  const headers = ['grupo', 'AN_conservado', 'titulo_conservado', 'fuente_conservada',
                   'AN_duplicado', 'titulo_duplicado', 'fuente_duplicado'];
  const rows = [];
  ep.confirmed.forEach((c, gi) => {
    c.removed.forEach(r => {
      rows.push([
        gi + 1,
        c.kept.accession || '', c.kept.title || '', c.kept._source || '',
        r.accession      || '', r.title      || '', r._source      || '',
      ]);
    });
  });
  const csv = [headers.map(escape).join(','), ...rows.map(r => r.map(escape).join(','))].join('\n');
  downloadFile('\ufeff' + csv, 'epistemonikos_duplicados.csv', 'text/csv;charset=utf-8');
  showToast(`${rows.length} par${rows.length > 1 ? 'es' : ''} exportado${rows.length > 1 ? 's' : ''}`, 'success');
}

// ── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const dropZone  = document.getElementById('drop-zone');
  const fileInput = document.getElementById('file-input');

  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { addFiles(fileInput.files); fileInput.value = ''; });
  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); dropZone.classList.remove('dragover');
    addFiles(e.dataTransfer.files);
  });

  document.getElementById('btn-clear-files').addEventListener('click', () => {
    st.files = []; renderFileList();
  });

  initSettings();

  document.getElementById('btn-run').addEventListener('click', runAnalysis);

  document.getElementById('filter-select').addEventListener('change', applyFilter);

  document.getElementById('general-doi-pills')?.addEventListener('click', e => {
    const pill = e.target.closest('[data-general-doi]');
    if (!pill) return;
    st.filterDOI = pill.dataset.generalDoi;
    document.querySelectorAll('[data-general-doi]').forEach(p =>
      p.classList.toggle('active', p.dataset.generalDoi === st.filterDOI));
    applyFilter();
  });

  document.getElementById('btn-keep-first-all').addEventListener('click', keepFirstAll);

  document.getElementById('btn-export-ris').addEventListener('click', exportRIS);
  document.getElementById('btn-export-csv').addEventListener('click', exportCSV);

  document.getElementById('btn-back').addEventListener('click', () => {
    document.getElementById('header-stats').style.display = 'none';
    homeShowFull();
  });

  // ── Tab switcher ──────────────────────────────────────────
  let activeTab = 'general';
  document.querySelectorAll('.app-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.app-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeTab = tab.dataset.tab;
      if      (activeTab === 'general') showSection('sec-upload');
      else if (activeTab === 'epistemo') epistemShowSessions();
      else if (activeTab === 'massive') { massiveShowSessions(); }
    });
  });

  // ── Epistemonikos events ──────────────────────────────────
  const epistDrop  = document.getElementById('epist-drop-zone');
  const epistInput = document.getElementById('epist-file-input');

  epistDrop.addEventListener('click', () => epistInput.click());
  epistInput.addEventListener('change', () => { epistAddFiles(epistInput.files); epistInput.value = ''; });
  epistDrop.addEventListener('dragover',  e => { e.preventDefault(); epistDrop.classList.add('dragover'); });
  epistDrop.addEventListener('dragleave', () => epistDrop.classList.remove('dragover'));
  epistDrop.addEventListener('drop', e => {
    e.preventDefault(); epistDrop.classList.remove('dragover');
    epistAddFiles(e.dataTransfer.files);
  });

  document.getElementById('epist-btn-clear-files').addEventListener('click', () => {
    ep.files = []; epistRenderFileList();
  });

  // Epistemonikos settings
  const epTSlider  = document.getElementById('epist-threshold-slider');
  const epTwSlider = document.getElementById('epist-tw-slider');
  const epWinSlider = document.getElementById('epist-win-slider');
  epTSlider.addEventListener('input', () => {
    ep.threshold = epTSlider.value / 100;
    document.getElementById('epist-threshold-val').textContent = epTSlider.value + '%';
  });
  epTwSlider.addEventListener('input', () => {
    ep.titleWeight = epTwSlider.value / 100;
    document.getElementById('epist-tw-val').textContent = epTwSlider.value + '%';
  });
  epWinSlider.addEventListener('input', () => {
    ep.windowSize = +epWinSlider.value;
    document.getElementById('epist-win-val').textContent = epWinSlider.value + ' refs';
  });
  document.querySelectorAll('input[name="epist-mode"]').forEach(radio => {
    radio.addEventListener('change', () => { ep.mode = radio.value; });
  });

  document.getElementById('epist-btn-run').addEventListener('click', epistRunAnalysis);
  document.getElementById('epist-btn-confirm-all').addEventListener('click', epistConfirmAll);
  document.getElementById('epist-btn-export-ris').addEventListener('click', epistExportRIS);
  document.getElementById('epist-btn-export-csv').addEventListener('click', epistExportCSV);

  document.getElementById('epist-btn-back').addEventListener('click', () => {
    ep.backendJobId = null;
    epistemShowSessions();
  });

  document.getElementById('epist-sessions-btn-new')?.addEventListener('click', () => {
    showSection('sec-epist-upload');
  });

  document.querySelectorAll('.epist-cat-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      ep.activeCategory = tab.dataset.cat;
      ep.page = 0;
      epistRenderCategoryTabs();
      epistRenderPending();
    });
  });

  document.getElementById('filter-doi-pills')?.addEventListener('click', e => {
    const pill = e.target.closest('[data-doi-filter]');
    if (!pill) return;
    ep.filterDOI = pill.dataset.doiFilter;
    ep.page = 0;
    document.querySelectorAll('[data-doi-filter]').forEach(p =>
      p.classList.toggle('active', p.dataset.doiFilter === ep.filterDOI));
    epistRenderPending();
  });
  document.getElementById('filter-match-pills')?.addEventListener('click', e => {
    const pill = e.target.closest('[data-match-filter]');
    if (!pill) return;
    ep.filterMatch = pill.dataset.matchFilter;
    ep.page = 0;
    document.querySelectorAll('[data-match-filter]').forEach(p =>
      p.classList.toggle('active', p.dataset.matchFilter === ep.filterMatch));
    epistRenderPending();
  });

  document.getElementById('epist-btn-show-confirmed').addEventListener('click', () => {
    const sec = document.getElementById('epist-confirmed-section');
    const btn = document.getElementById('epist-btn-show-confirmed');
    const visible = sec.style.display !== 'none';
    sec.style.display = visible ? 'none' : '';
    btn.textContent = visible ? 'Ver tabla de confirmados ▾' : 'Ocultar tabla ▴';
  });

  // ── Home screen init ──────────────────────────────────────
  document.getElementById('home-btn-new')?.addEventListener('click', () => {
    showSection('sec-upload');
  });

  document.getElementById('btn-home-tab')?.addEventListener('click', () => {
    document.querySelectorAll('.app-tab').forEach(t => t.classList.remove('active'));
    document.getElementById('btn-home-tab').classList.add('active');
    homeShowFull();
  });

  // ── Massive mode init ─────────────────────────────────────
  massiveInit();

  // Open home screen on load (shows all sessions across all modes)
  homeShowFull();
});

/* ==========================================================
   GRAN ESCALA — MASSIVE MODE
   ========================================================== */

const mv = {
  files:          [],
  jobId:          null,
  pollTimer:      null,
  results:        null,
  // Exact categories (doi, an): batch decision
  batchDecisions: { doi: null, an: null },
  // Similarity categories (high, med, low): per-group decisions { groupIndex: 'confirmed'|'skipped' }
  groupDecisions: {},
  // Review state
  reviewCat:         null,
  reviewPage:        0,
  reviewData:        null,   // current page data from backend
  reviewFilterDOI:   'all',  // 'all' | 'has' | 'no'
  threshold:      0.82,
  windowSize:     80,
  mode:           'both',
};

const _CAT_META = {
  doi:  { label: 'DOI exacto',        dot: 'dot-doi',  hint: 'Dos o más referencias comparten exactamente el mismo DOI. Alta certeza.' },
  an:   { label: 'ID externo (AN)',    dot: 'dot-an',   hint: 'Número de acceso idéntico entre referencias.' },
  high: { label: 'Similitud alta ≥90%', dot: 'dot-high', hint: 'Títulos/resúmenes muy similares. Probables duplicados.' },
  med:  { label: 'Similitud media 75–90%', dot: 'dot-med', hint: 'Similitud moderada. Revisar la muestra antes de confirmar.' },
  low:  { label: 'Similitud baja <75%', dot: 'dot-low', hint: 'Baja similitud. Confirmar solo si la muestra lo justifica.' },
};

async function massiveCheckBackend() {
  try {
    const res = await fetch('/api/ping');
    const ok  = res.ok;
    document.getElementById('massive-backend-warn').style.display = ok ? 'none' : 'flex';
  } catch {
    document.getElementById('massive-backend-warn').style.display = 'flex';
  }
}

// ── Session persistence ────────────────────────────────────────

async function massiveShowSessions() {
  showSection('sec-massive-sessions');
  massiveCheckBackend();
  const list = document.getElementById('sessions-list');
  list.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8">Cargando sesiones…</div>';
  try {
    const res      = await fetch('/api/sessions');
    const all      = await res.json();
    const sessions = all.filter(s => (s.mode || 'massive') === 'massive');
    if (!sessions.length) {
      list.innerHTML = `<div class="sessions-empty">
        <p style="font-weight:600">No hay sesiones guardadas</p>
        <p style="font-size:.85rem;color:#94a3b8;margin-top:4px">Sube un archivo RIS para comenzar.</p>
      </div>`;
      return;
    }
    list.innerHTML = sessions.map(_sessionCard).join('');
    list.querySelectorAll('.sessions-btn-resume').forEach(btn =>
      btn.addEventListener('click', () => massiveResumeSession(btn.dataset.jobId))
    );
    list.querySelectorAll('.sessions-btn-delete').forEach(btn =>
      btn.addEventListener('click', () => massiveDeleteSession(btn.dataset.jobId))
    );
  } catch {
    list.innerHTML = '<div style="text-align:center;padding:40px;color:#f87171">Backend no disponible</div>';
  }
}

function _sessionCard(s) {
  const total     = s.total_groups || 0;
  const done      = (s.confirmed || 0) + (s.skipped || 0);
  const pend      = total - done;
  const pct       = total > 0 ? Math.round(done / total * 100) : 0;
  const files     = (s.filenames || []).join(', ') || 'Sin nombre';
  const batches   = (s.batch_confirmed || [])
    .map(k => `<span class="session-batch-tag">${_CAT_META[k]?.label || k}</span>`).join('');
  const totalRefs = s.total_refs || 0;
  const remaining = s.refs_remaining !== undefined ? s.refs_remaining : totalRefs;
  const refsLabel = remaining < totalRefs
    ? `${remaining.toLocaleString()} refs únicas (de ${totalRefs.toLocaleString()})`
    : `${totalRefs.toLocaleString()} refs`;
  return `<div class="session-card">
    <div class="session-card-info">
      <div class="session-card-file">${files}</div>
      <div class="session-card-meta">${s.created_at || ''} · ${refsLabel} · ${total.toLocaleString()} grupos</div>
      ${batches ? `<div class="session-batch-tags">Confirmados en bloque: ${batches}</div>` : ''}
      <div class="session-card-progress">
        <div class="session-progress-bar"><div class="session-progress-fill" style="width:${pct}%"></div></div>
        <span class="session-progress-label">${done.toLocaleString()} revisados · <strong>${pend.toLocaleString()} pendientes</strong></span>
      </div>
    </div>
    <div class="session-card-actions">
      <button class="btn-primary sessions-btn-resume" data-job-id="${s.job_id}">Retomar →</button>
      <button class="btn-text sessions-btn-delete" data-job-id="${s.job_id}" style="color:#f87171;font-size:.8rem">Eliminar</button>
    </div>
  </div>`;
}

async function massiveResumeSession(jobId) {
  showSection('sec-processing');
  setProgress('Iniciando carga de sesión…', 2);
  try {
    const loadRes  = await fetch(`/api/sessions/${jobId}/load`, { method: 'POST' });
    const loadData = await loadRes.json();
    mv.jobId = jobId;
    const mode = loadData.mode || 'massive';

    if (!loadData.already_loaded) {
      await new Promise((resolve, reject) => {
        const timer = setInterval(async () => {
          try {
            const p = await (await fetch(`/api/progress/${jobId}`)).json();
            setProgress(p.message, p.pct);
            if (p.status === 'done')  { clearInterval(timer); resolve(); }
            if (p.status === 'error') { clearInterval(timer); reject(new Error(p.message)); }
          } catch (e) { clearInterval(timer); reject(e); }
        }, 1000);
      });
    }

    if (mode === 'epistemo') {
      await epistemLoadFromBackend(jobId);
      return;
    }

    // Restore saved decisions for massive mode
    const dec = await (await fetch(`/api/sessions/${jobId}/decisions`)).json();
    mv.batchDecisions = { doi: dec.batch?.doi || null, an: dec.batch?.an || null };
    mv.groupDecisions = dec.groups || {};

    await massiveLoadResults();
  } catch (e) {
    showToast('Error cargando sesión: ' + e.message, 'error');
    homeShowFull();
  }
}

/* ── Epistemonikos sessions list ────────────────────────── */

async function epistemShowSessions() {
  showSection('sec-epist-sessions');
  const list = document.getElementById('epist-sessions-list');
  list.innerHTML = '<div style="text-align:center;padding:40px;color:#94a3b8">Cargando sesiones…</div>';
  try {
    const res  = await fetch('/api/sessions');
    const all  = await res.json();
    const sessions = all.filter(s => (s.mode || 'epistemo') === 'epistemo');
    if (!sessions.length) {
      list.innerHTML = `<div class="sessions-empty">
        <p style="font-weight:600">No hay sesiones guardadas</p>
        <p style="font-size:.85rem;color:#94a3b8;margin-top:4px">Sube archivos RIS para comenzar.</p>
      </div>`;
      return;
    }
    list.innerHTML = sessions.map(_sessionCard).join('');
    list.querySelectorAll('.sessions-btn-resume').forEach(btn =>
      btn.addEventListener('click', () => massiveResumeSession(btn.dataset.jobId))
    );
    list.querySelectorAll('.sessions-btn-delete').forEach(btn =>
      btn.addEventListener('click', async () => {
        if (!confirm('¿Eliminar esta sesión?')) return;
        await fetch(`/api/sessions/${btn.dataset.jobId}`, { method: 'DELETE' });
        epistemShowSessions();
      })
    );
  } catch {
    list.innerHTML = '<div style="text-align:center;padding:40px;color:#f87171">Backend no disponible</div>';
  }
}

/* ── Epistemonikos backend persistence ───────────────────── */

async function epistemSaveToBackend() {
  try {
    const filenames  = ep.files.map(f => f.name);
    const customName = document.getElementById('epist-session-name')?.value.trim();
    const name       = customName || filenames.join(', ') || 'Sin nombre';
    const res = await fetch('/api/sessions/save', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        mode:      'epistemo',
        filenames,
        refs:      ep.allRefs,
        groups:    ep.groups,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      ep.backendJobId = data.job_id;
      showToast('Sesión guardada — disponible en "Epistemonikos → Sesiones"', 'success');
    }
  } catch { /* backend may not be available */ }
}

let _epistSaveTimer = null;
function epistemSaveDecisions() {
  if (!ep.backendJobId) return;
  clearTimeout(_epistSaveTimer);
  _epistSaveTimer = setTimeout(async () => {
    const refIdx = r => ep.allRefs.indexOf(r);
    const decisions = {
      batch:  {},
      groups: {},
      epist: {
        confirmed: ep.confirmed.map(c => ({
          keptId:     c.kept.id,
          removedIds: c.removed.map(r => r.id),
          reason:     c.reason,
        })),
        discarded: [...ep.discarded],
      },
    };
    try {
      await fetch(`/api/sessions/${ep.backendJobId}/decisions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(decisions),
      });
    } catch {}
  }, 800);
}

async function epistemLoadFromBackend(jobId) {
  try {
    showSection('sec-processing');
    setProgress('Cargando sesión Epistemonikos…', 20);

    const fullRes = await fetch(`/api/sessions/${jobId}/full`);
    if (!fullRes.ok) throw new Error('No se pudo cargar la sesión');
    const data = await fullRes.json();

    setProgress('Restaurando referencias…', 60);
    ep.allRefs      = data.refs;
    ep.groups       = data.groups;
    ep.files        = [];
    ep.page         = 0;
    ep.backendJobId = jobId;
    _epistSel.clear();

    setProgress('Restaurando decisiones…', 80);
    const dec      = await (await fetch(`/api/sessions/${jobId}/decisions`)).json();
    ep.confirmed   = [];
    ep.discarded   = new Set();

    const epistDec = dec.epist || {};
    const refById  = new Map(ep.allRefs.map(r => [r.id, r]));

    for (const c of (epistDec.confirmed || [])) {
      const kept    = refById.get(c.keptId);
      const removed = (c.removedIds || []).map(id => refById.get(id)).filter(Boolean);
      if (kept) ep.confirmed.push({ kept, removed, reason: c.reason });
    }
    for (const idx of (epistDec.discarded || [])) {
      ep.discarded.add(idx);
    }

    setProgress('¡Listo!', 100);
    await delay(200);
    epistRenderResults();
    epistemShowSection('sec-epist-results');
  } catch (e) {
    showToast('Error cargando sesión: ' + e.message, 'error');
    homeShowFull();
  }
}

async function massiveDeleteSession(jobId) {
  if (!confirm('¿Eliminar esta sesión? Se perderán las decisiones guardadas.')) return;
  await fetch(`/api/sessions/${jobId}`, { method: 'DELETE' });
  massiveShowSessions();
}

// Auto-save decisions to backend (debounced 800ms)
let _saveTimer = null;
function _autoSave() {
  if (!mv.jobId) return;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    fetch(`/api/sessions/${mv.jobId}/decisions`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ batch: mv.batchDecisions, groups: mv.groupDecisions }),
    }).catch(() => {});
  }, 800);
}

function massiveInit() {
  const dropZone  = document.getElementById('massive-drop-zone');
  const fileInput = document.getElementById('massive-file-input');

  dropZone.addEventListener('click',    () => fileInput.click());
  fileInput.addEventListener('change',  () => { massiveAddFiles(fileInput.files); fileInput.value = ''; });
  dropZone.addEventListener('dragover', e  => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave',() => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop',     e  => {
    e.preventDefault(); dropZone.classList.remove('dragover');
    massiveAddFiles(e.dataTransfer.files);
  });

  document.getElementById('massive-btn-clear').addEventListener('click', () => {
    mv.files = []; massiveRenderFileList();
  });

  const tSlider   = document.getElementById('massive-threshold-slider');
  const winSlider = document.getElementById('massive-win-slider');
  tSlider.addEventListener('input',   () => {
    mv.threshold = tSlider.value / 100;
    document.getElementById('massive-threshold-val').textContent = tSlider.value + '%';
  });
  winSlider.addEventListener('input', () => {
    mv.windowSize = +winSlider.value;
    document.getElementById('massive-win-val').textContent = winSlider.value + ' refs';
  });
  document.querySelectorAll('input[name="massive-mode"]').forEach(r =>
    r.addEventListener('change', () => { mv.mode = r.value; })
  );

  document.getElementById('sessions-btn-new').addEventListener('click', () => {
    showSection('sec-massive-upload');
    massiveCheckBackend();
  });
  document.getElementById('massive-btn-run').addEventListener('click', massiveRun);
  document.getElementById('massive-btn-confirm-all').addEventListener('click', massiveConfirmAll);
  document.getElementById('massive-btn-export').addEventListener('click', massiveExport);
  document.getElementById('massive-btn-back').addEventListener('click', () => {
    showSection('sec-massive-upload');
  });
  document.getElementById('massive-btn-sessions').addEventListener('click', massiveShowSessions);
  document.getElementById('review-btn-back').addEventListener('click', () => {
    showSection('sec-massive-results');
  });

  document.getElementById('review-doi-pills')?.addEventListener('click', e => {
    const pill = e.target.closest('[data-review-doi]');
    if (!pill) return;
    mv.reviewFilterDOI = pill.dataset.reviewDoi;
    document.querySelectorAll('[data-review-doi]').forEach(p =>
      p.classList.toggle('active', p.dataset.reviewDoi === mv.reviewFilterDOI));
    massiveRenderReview();
  });
}

function massiveAddFiles(fileList) {
  for (const file of fileList) {
    const nl = file.name.toLowerCase();
    if (!nl.endsWith('.ris') && !nl.endsWith('.nbib')) continue;
    if (mv.files.find(f => f.name === file.name)) continue;
    mv.files.push(file);
  }
  massiveRenderFileList();
}

function massiveRenderFileList() {
  const list  = document.getElementById('massive-file-list');
  const items = document.getElementById('massive-file-items');
  const btn   = document.getElementById('massive-btn-run');

  if (!mv.files.length) { list.style.display = 'none'; btn.disabled = true; return; }
  list.style.display = '';
  btn.disabled = false;

  items.innerHTML = mv.files.map((f, i) => `
    <div class="file-item">
      <svg class="file-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <span class="file-item-name" title="${f.name}">${f.name}</span>
      <span class="file-item-count">${(f.size / 1024 / 1024).toFixed(1)} MB</span>
      <button class="file-item-remove" data-idx="${i}" title="Quitar">×</button>
    </div>`).join('');

  document.getElementById('massive-file-total').textContent =
    `Total: ${mv.files.length} archivo${mv.files.length > 1 ? 's' : ''}`;

  items.querySelectorAll('.file-item-remove').forEach(b =>
    b.addEventListener('click', e => {
      mv.files.splice(+e.currentTarget.dataset.idx, 1);
      massiveRenderFileList();
    })
  );
}

async function massiveRun() {
  const backendOk = await massiveCheckBackend().then(() =>
    document.getElementById('massive-backend-warn').style.display === 'none'
  );
  if (!backendOk) {
    showToast('Inicia el backend primero: cd backend && python main.py', 'error');
    return;
  }
  if (!mv.files.length) return;

  const formData = new FormData();
  for (const file of mv.files) formData.append('files', file);
  formData.append('threshold',    mv.threshold);
  formData.append('title_weight', 0.80);
  formData.append('window_size',  mv.windowSize);
  formData.append('mode',         mv.mode);

  showSection('sec-processing');
  setProgress('Enviando archivos al servidor…', 3);

  try {
    const res  = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Error al subir archivos');
    mv.jobId = data.job_id;
    mv.decisions = { doi: null, an: null, high: null, med: null, low: null };
    massivePoll();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
    showSection('sec-massive-upload');
  }
}

function massivePoll() {
  clearInterval(mv.pollTimer);
  mv.pollTimer = setInterval(async () => {
    try {
      const res  = await fetch(`/api/progress/${mv.jobId}`);
      const data = await res.json();
      setProgress(data.message, data.pct);

      if (data.status === 'done') {
        clearInterval(mv.pollTimer);
        await massiveLoadResults();
      } else if (data.status === 'error') {
        clearInterval(mv.pollTimer);
        showToast('Error en el servidor: ' + data.message, 'error');
        showSection('sec-massive-upload');
      }
    } catch {
      clearInterval(mv.pollTimer);
      showToast('Se perdió la conexión con el backend', 'error');
    }
  }, 2000);
}

async function massiveLoadResults() {
  const res  = await fetch(`/api/results/${mv.jobId}`);
  mv.results = await res.json();
  massiveRenderResults();
  showSection('sec-massive-results');
}

// ── Helpers ──────────────────────────────────────────────────
const _SIM_CATS  = ['high', 'med', 'low'];
const _EXACT_CATS = ['doi', 'an'];

function _anLink(an) {
  return an
    ? `<a class="epist-an-link" href="https://www.epistemonikos.org/documents/${an}" target="_blank" rel="noopener">${an}</a>`
    : '—';
}

function _catReviewedCount(cat) {
  const indices = mv.results?._groupIndices?.[cat] || [];
  return indices.filter(gi => mv.groupDecisions[gi] !== undefined).length;
}

// ── Overview rendering ────────────────────────────────────────

function massiveRenderResults() {
  const r = mv.results;
  document.getElementById('massive-stats').innerHTML = `
    <span class="stat-chip chip-total">${r.total_refs.toLocaleString()} refs totales</span>
    <span class="stat-chip chip-groups">${r.total_groups.toLocaleString()} grupos detectados</span>
  `;
  document.getElementById('massive-export-result').style.display = 'none';

  const wrap = document.getElementById('batch-cards');
  wrap.innerHTML = Object.entries(_CAT_META).map(([cat, meta]) => {
    const data = r.categories[cat];
    if (!data || data.count === 0) return '';
    return massiveCatCard(cat, meta, data);
  }).join('');

  // Exact cats: batch confirm/skip
  wrap.querySelectorAll('.btn-batch-confirm').forEach(btn =>
    btn.addEventListener('click', () => massiveBatchDecide(btn.dataset.cat, 'confirmed'))
  );
  wrap.querySelectorAll('.btn-batch-skip').forEach(btn =>
    btn.addEventListener('click', () => massiveBatchDecide(btn.dataset.cat, 'skipped'))
  );
  wrap.querySelectorAll('.btn-batch-undo').forEach(btn =>
    btn.addEventListener('click', () => massiveBatchDecide(btn.dataset.cat, null))
  );
  // Similarity cats: open review
  wrap.querySelectorAll('.btn-batch-review').forEach(btn =>
    btn.addEventListener('click', () => massiveOpenReview(btn.dataset.cat))
  );
}

function massiveCatCard(cat, meta, data) {
  const isExact = _EXACT_CATS.includes(cat);
  let actionHtml;

  if (isExact) {
    const state = mv.batchDecisions[cat];
    if (state === 'confirmed') {
      actionHtml = `<span class="batch-decision-badge badge-confirmed">✓ Confirmado</span>
                    <button class="btn-batch-undo" data-cat="${cat}">Deshacer</button>`;
    } else if (state === 'skipped') {
      actionHtml = `<span class="batch-decision-badge badge-skipped">— Descartado</span>
                    <button class="btn-batch-undo" data-cat="${cat}">Deshacer</button>`;
    } else {
      actionHtml = `<button class="btn-batch-confirm" data-cat="${cat}">Confirmar todos</button>
                    <button class="btn-batch-skip"    data-cat="${cat}">Descartar</button>`;
    }
  } else {
    const reviewed = _catReviewedCount(cat);
    const total    = data.count;
    const confirmed = (mv.results?._groupIndices?.[cat] || [])
      .filter(gi => mv.groupDecisions[gi] === 'confirmed').length;
    const progDone = reviewed >= total;
    const progLabel = reviewed === 0
      ? 'Sin revisar'
      : `${reviewed.toLocaleString()} / ${total.toLocaleString()} revisados · ${confirmed.toLocaleString()} confirmados`;
    actionHtml = `
      <span class="batch-cat-progress${progDone ? ' prog-done' : ''}">${progLabel}</span>
      <button class="btn-batch-review" data-cat="${cat}">Revisar grupo a grupo →</button>`;
  }

  const samplesHtml = data.sample.map(g => {
    const [m0, m1] = g.members;
    if (!m0 || !m1) return '';
    const badge = scoreLabel(g.max_score, g.reason);
    return `<div class="batch-sample-group">
      <div class="batch-ref-row">
        <span class="batch-ref-title">${m0.title || '(sin título)'}</span>
        <span class="batch-ref-meta">${[m0.year, m0.source].filter(Boolean).join(' · ')}${m0.accession ? ' · AN: ' + _anLink(m0.accession) : ''}</span>
      </div>
      <div class="batch-sim-row">
        <span class="group-score-badge ${badge.cls}" style="font-size:.7rem;padding:1px 7px">${badge.label}</span>
      </div>
      <div class="batch-ref-row">
        <span class="batch-ref-title">${m1.title || '(sin título)'}</span>
        <span class="batch-ref-meta">${[m1.year, m1.source].filter(Boolean).join(' · ')}${m1.accession ? ' · AN: ' + _anLink(m1.accession) : ''}</span>
      </div>
    </div>`;
  }).join('');

  return `<div class="batch-card" data-cat="${cat}">
    <div class="batch-card-header">
      <span class="batch-cat-dot ${meta.dot}" title="${meta.hint}"></span>
      <span class="batch-cat-label">${meta.label}</span>
      <span class="batch-cat-stats">${data.count.toLocaleString()} grupos · ${data.refs_affected.toLocaleString()} refs</span>
      <span class="batch-card-spacer"></span>
      <div class="batch-card-decision">${actionHtml}</div>
    </div>
    ${samplesHtml ? `<div class="batch-samples">
      <div class="batch-sample-title">Muestra (${Math.min(data.sample.length, 5)} de ${data.count.toLocaleString()} grupos)</div>
      ${samplesHtml}
    </div>` : ''}
  </div>`;
}

function massiveBatchDecide(cat, state) {
  mv.batchDecisions[cat] = state;
  massiveRenderResults();
  _autoSave();
}

function massiveConfirmAll() {
  // Exact cats: batch confirm
  for (const cat of _EXACT_CATS) {
    if (mv.results?.categories[cat]?.count > 0) mv.batchDecisions[cat] = 'confirmed';
  }
  // Similarity cats: confirm all reviewed groups (and mark remaining as confirmed too)
  for (const cat of _SIM_CATS) {
    for (const gi of (mv.results?._groupIndices?.[cat] || [])) {
      mv.groupDecisions[gi] = 'confirmed';
    }
  }
  massiveRenderResults();
  showToast('Todos los grupos marcados como confirmados', 'success');
}

async function massiveExport() {
  const batch  = {};
  for (const cat of _EXACT_CATS) {
    batch[cat] = mv.batchDecisions[cat] === 'confirmed' ? 'confirm' : 'skip';
  }

  const exportBtn = document.getElementById('massive-btn-export');
  exportBtn.disabled  = true;
  exportBtn.textContent = 'Procesando…';

  try {
    const res  = await fetch(`/api/export/${mv.jobId}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ batch, groups: mv.groupDecisions }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || 'Error al exportar');

    const resultEl = document.getElementById('massive-export-result');
    resultEl.style.display = 'flex';
    resultEl.innerHTML = `<svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M5 10l4 4 6-8" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span><strong>${data.kept.toLocaleString()}</strong> refs conservadas · <strong>${data.removed.toLocaleString()}</strong> eliminadas · ${data.pairs.toLocaleString()} pares en CSV</span>`;

    window.location.href = `/api/download/${mv.jobId}/ris`;
    setTimeout(() => { window.location.href = `/api/download/${mv.jobId}/csv`; }, 800);

  } catch (e) {
    showToast('Error al exportar: ' + e.message, 'error');
  } finally {
    exportBtn.disabled = false;
    exportBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M10 2v10m0 0l-3-3m3 3l3-3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 14v2a2 2 0 002 2h8a2 2 0 002-2v-2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg> Exportar y descargar`;
  }
}

// ── Review section ────────────────────────────────────────────

async function massiveOpenReview(cat) {
  mv.reviewCat       = cat;
  mv.reviewPage      = 0;
  mv.reviewFilterDOI = 'all';
  document.querySelectorAll('[data-review-doi]').forEach(p =>
    p.classList.toggle('active', p.dataset.reviewDoi === 'all'));
  showSection('sec-massive-review');
  document.getElementById('review-cat-label').textContent = _CAT_META[cat].label;
  await massiveLoadReviewPage(0);
}

async function massiveLoadReviewPage(page) {
  mv.reviewPage = page;
  document.getElementById('review-groups').innerHTML =
    '<div style="text-align:center;padding:40px;color:#94a3b8">Cargando…</div>';

  try {
    const res  = await fetch(`/api/groups/${mv.jobId}/${mv.reviewCat}?page=${page}&per_page=50`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    if (!Array.isArray(data.groups)) throw new Error('Respuesta inesperada del servidor');
    mv.reviewData = data;

    // Cache group indices per category for progress tracking
    if (!mv.results._groupIndices) mv.results._groupIndices = {};
    if (!mv.results._groupIndices[mv.reviewCat]) {
      mv.results._groupIndices[mv.reviewCat] = mv.reviewData.groups.map(g => g.group_index);
    }

    massiveRenderReview();
  } catch (e) {
    document.getElementById('review-groups').innerHTML =
      `<div style="text-align:center;padding:40px;color:#f87171">Error cargando grupos: ${e.message}</div>`;
    showToast('Error cargando grupos: ' + e.message, 'error');
  }
}

function massiveRenderReview() {
  const d     = mv.reviewData;
  const total = d.total;
  const start = mv.reviewPage * 50;

  // Apply DOI filter on the current page's groups
  const groups = mv.reviewFilterDOI === 'all' ? d.groups : d.groups.filter(g => {
    const hasDOI = g.members.some(m => m.doi);
    return mv.reviewFilterDOI === 'has' ? hasDOI : !hasDOI;
  });

  const confirmed = Object.values(mv.groupDecisions).filter(v => v === 'confirmed').length;
  const filterNote = mv.reviewFilterDOI !== 'all'
    ? ` · ${groups.length} visibles (filtro DOI)` : '';
  document.getElementById('review-progress').textContent =
    `Página ${mv.reviewPage + 1} de ${Math.ceil(total / 50)} · ${total.toLocaleString()} grupos${filterNote} · ${confirmed.toLocaleString()} confirmados en total`;

  const wrap = document.getElementById('review-groups');
  wrap.innerHTML = groups.map((g, idx) => {
    const gi    = g.group_index;
    const state = mv.groupDecisions[gi] || 'pending';
    const badge = scoreLabel(g.max_score, g.reason);
    const num   = start + idx + 1;

    let decisionHtml;
    if (state === 'confirmed') {
      decisionHtml = `<span class="batch-decision-badge badge-confirmed" style="font-size:.75rem">✓ Duplicado confirmado</span>
                      <button class="btn-batch-undo btn-rev-undo" data-gi="${gi}">Deshacer</button>`;
    } else if (state === 'skipped') {
      decisionHtml = `<span class="batch-decision-badge badge-skipped" style="font-size:.75rem">— No es duplicado</span>
                      <button class="btn-batch-undo btn-rev-undo" data-gi="${gi}">Deshacer</button>`;
    } else {
      decisionHtml = `<button class="btn-rev-confirm" data-gi="${gi}">✓ Confirmar duplicado</button>
                      <button class="btn-rev-skip"    data-gi="${gi}">✗ No es duplicado</button>`;
    }

    const refsHtml = g.members.map((m, mi) => {
      const metaParts = [m.year, m.source].filter(Boolean).join(' · ');
      return `${mi > 0 ? '<div class="massive-review-sep">≡ posible duplicado de ↑</div>' : ''}
        <div class="massive-review-ref-row">
          <div class="massive-review-ref-body">
            <div class="massive-review-ref-title">${m.title || '(sin título)'}</div>
            <div class="massive-review-ref-meta">
              ${m.accession ? `AN: ${_anLink(m.accession)} · ` : ''}${metaParts}
              ${m.doi ? ` · DOI: ${m.doi}` : ''}
            </div>
          </div>
        </div>`;
    }).join('');

    return `<div class="massive-review-card" data-gi="${gi}" data-state="${state}">
      <div class="massive-review-card-header">
        <span class="group-score-badge ${badge.cls}">${badge.label}</span>
        <div class="massive-review-card-decision">${decisionHtml}</div>
        <span class="massive-review-num">#${num.toLocaleString()}</span>
      </div>
      <div class="massive-review-refs">${refsHtml}</div>
    </div>`;
  }).join('');

  // Events: confirm / skip / undo per group
  wrap.querySelectorAll('.btn-rev-confirm').forEach(btn =>
    btn.addEventListener('click', () => massiveGroupDecide(+btn.dataset.gi, 'confirmed'))
  );
  wrap.querySelectorAll('.btn-rev-skip').forEach(btn =>
    btn.addEventListener('click', () => massiveGroupDecide(+btn.dataset.gi, 'skipped'))
  );
  wrap.querySelectorAll('.btn-rev-undo').forEach(btn =>
    btn.addEventListener('click', () => massiveGroupDecide(+btn.dataset.gi, null))
  );

  // Pagination
  const totalPages = Math.ceil(total / 50);
  const pg = document.getElementById('review-pagination');
  if (totalPages <= 1) { pg.innerHTML = ''; return; }

  const p = mv.reviewPage;
  let html = `<button class="page-btn" ${p === 0 ? 'disabled' : ''} data-p="${p - 1}">← Anterior</button>`;
  const ps = Math.max(0, p - 3), pe = Math.min(totalPages, p + 4);
  if (ps > 0)         html += `<button class="page-btn" data-p="0">1</button><span>…</span>`;
  for (let i = ps; i < pe; i++)
    html += `<button class="page-btn${i === p ? ' active' : ''}" data-p="${i}">${i + 1}</button>`;
  if (pe < totalPages) html += `<span>…</span><button class="page-btn" data-p="${totalPages - 1}">${totalPages}</button>`;
  html += `<button class="page-btn" ${p >= totalPages - 1 ? 'disabled' : ''} data-p="${p + 1}">Siguiente →</button>`;
  html += `<span style="font-size:.78rem;color:#64748b;margin-left:6px">Página ${p + 1} de ${totalPages} · ${total.toLocaleString()} grupos</span>`;

  pg.innerHTML = html;
  pg.querySelectorAll('.page-btn:not(:disabled)').forEach(btn =>
    btn.addEventListener('click', () => {
      massiveLoadReviewPage(+btn.dataset.p);
      document.getElementById('review-groups').scrollIntoView({ behavior: 'smooth', block: 'start' });
    })
  );
}

function massiveGroupDecide(gi, state) {
  if (state === null) delete mv.groupDecisions[gi];
  else                mv.groupDecisions[gi] = state;
  _autoSave();

  // Re-render just this card without reloading from backend
  const card = document.querySelector(`.massive-review-card[data-gi="${gi}"]`);
  if (card) {
    card.dataset.state = state || 'pending';
    const dec = card.querySelector('.massive-review-card-decision');
    if (state === 'confirmed') {
      dec.innerHTML = `<span class="batch-decision-badge badge-confirmed" style="font-size:.75rem">✓ Duplicado confirmado</span>
                       <button class="btn-batch-undo btn-rev-undo" data-gi="${gi}">Deshacer</button>`;
    } else if (state === 'skipped') {
      dec.innerHTML = `<span class="batch-decision-badge badge-skipped" style="font-size:.75rem">— No es duplicado</span>
                       <button class="btn-batch-undo btn-rev-undo" data-gi="${gi}">Deshacer</button>`;
    } else {
      dec.innerHTML = `<button class="btn-rev-confirm" data-gi="${gi}">✓ Confirmar duplicado</button>
                       <button class="btn-rev-skip"    data-gi="${gi}">✗ No es duplicado</button>`;
    }
    dec.querySelectorAll('.btn-rev-confirm').forEach(b =>
      b.addEventListener('click', () => massiveGroupDecide(+b.dataset.gi, 'confirmed'))
    );
    dec.querySelectorAll('.btn-rev-skip').forEach(b =>
      b.addEventListener('click', () => massiveGroupDecide(+b.dataset.gi, 'skipped'))
    );
    dec.querySelectorAll('.btn-rev-undo').forEach(b =>
      b.addEventListener('click', () => massiveGroupDecide(+b.dataset.gi, null))
    );
  }

  // Update progress line
  const confirmed = Object.values(mv.groupDecisions).filter(v => v === 'confirmed').length;
  const prog = document.getElementById('review-progress');
  if (prog && mv.reviewData) {
    const total = mv.reviewData.total;
    prog.textContent = `Página ${mv.reviewPage + 1} de ${Math.ceil(total / 50)} · ${total.toLocaleString()} grupos · ${confirmed.toLocaleString()} confirmados en total`;
  }
}
