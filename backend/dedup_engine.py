"""
Deduplication engine — Python port of dedup.js
Algorithm: DOI/AN exact match + Sorted Neighborhood (Jaccard)
Complexity: O(n × W)
"""
import re
import unicodedata
from typing import Callable, Optional

STOP_WORDS = {
    # English
    'the','a','an','of','in','and','or','for','to','is','are','was','were','be','been',
    'by','with','on','at','from','that','this','which','it','as','its','their','has',
    'have','had','not','but','we','they','you','our','who','how','when','where','what',
    'after','before','during','between','about','more','most','some','any','all','both',
    'each','other','such','through','than','then','there','these','those','can','could',
    'may','might','will','would','shall','should','must','do','does','did','also','only',
    'just','very','many','much','two','one','three','four','five','six','seven','eight',
    'study','studies','using','used','based','associated','patients','results','methods',
    'conclusion','background','objective','purpose','design','setting','randomized',
    'trial','review','systematic','meta','analysis','effect','effects','outcome','outcomes',
    # Spanish
    'de','la','el','los','las','en','y','o','a','un','una','unos','unas','del','al',
    'por','para','con','sin','sobre','entre','bajo','desde','hasta','segun','durante',
    'aunque','porque','como','cuando','donde','quien','cuyo','cual','que','se','su','sus',
    'este','esta','estos','estas','ese','esa','esos','esas','mas','muy','todo','todos',
    'toda','todas','otro','otra','otros','otras','mismo','misma','ya','asi','hay','son',
    'fue','era','tiene','puede','estudio','estudios','pacientes','resultados','metodos',
    'objetivo','conclusion','revision','sistematica','analisis','efecto','efectos',
}


def normalize_str(text: str) -> str:
    if not text:
        return ''
    text = text.lower()
    text = unicodedata.normalize('NFD', text)
    text = ''.join(c for c in text if unicodedata.category(c) != 'Mn')
    text = re.sub(r'[^\w\s]', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def tokenize(text: str) -> list[str]:
    return [
        w for w in normalize_str(text).split()
        if len(w) > 2 and w not in STOP_WORDS and not re.match(r'^\d{1,3}$', w)
    ]


def jaccard(a: frozenset, b: frozenset) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / (len(a) + len(b) - inter)


def prefix_ratio(a: str, b: str) -> float:
    length = min(len(a), len(b), 20)
    i = 0
    while i < length and a[i] == b[i]:
        i += 1
    return i / max(len(a), len(b), 1)


class UnionFind:
    def __init__(self, n: int):
        self.p = list(range(n))
        self.r = [0] * n

    def find(self, x: int) -> int:
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, x: int, y: int) -> bool:
        px, py = self.find(x), self.find(y)
        if px == py:
            return False
        if self.r[px] < self.r[py]:
            self.p[px] = py
        elif self.r[px] > self.r[py]:
            self.p[py] = px
        else:
            self.p[py] = px
            self.r[px] += 1
        return True


def run_dedup(
    refs: list[dict],
    opts: Optional[dict] = None,
    progress_cb: Optional[Callable[[int, str], None]] = None,
) -> dict:
    """
    Main deduplication function.
    Returns {'groups': [...], 'total_pairs': int}
    """
    if opts is None:
        opts = {}

    threshold       = opts.get('threshold',       0.82)
    title_weight    = opts.get('title_weight',    0.80)
    abstract_weight = opts.get('abstract_weight', 0.20)
    window_size     = opts.get('window_size',     80)
    mode            = opts.get('mode',            'both')

    n   = len(refs)
    uf  = UnionFind(n)
    pair_scores: dict[str, dict] = {}

    def report(pct: int, msg: str):
        if progress_cb:
            progress_cb(pct, msg)

    _REASON_PRIO = {'doi': 0, 'an': 1, 'title_abstract': 2, 'title': 3, 'journal': 4}

    def add_pair(a: int, b: int, data: dict):
        uf.union(a, b)
        lo, hi = min(a, b), max(a, b)
        key = f'{lo}-{hi}'
        existing = pair_scores.get(key)
        if not existing:
            pair_scores[key] = data
            return
        ep = _REASON_PRIO.get(existing['reason'], 99)
        np = _REASON_PRIO.get(data['reason'],     99)
        if np < ep or (np == ep and data['score'] > existing['score']):
            pair_scores[key] = data

    report(5, f'Analizando {n:,} referencias…')

    # ── 1. DOI exact match ───────────────────────────────────
    doi_map: dict[str, list[int]] = {}
    for i, r in enumerate(refs):
        d = (r.get('doi') or '').lower().strip()
        if d:
            doi_map.setdefault(d, []).append(i)
    for grp in doi_map.values():
        for a in range(len(grp) - 1):
            for b in range(a + 1, len(grp)):
                add_pair(grp[a], grp[b], {
                    'score': 1.0, 'title_sim': 1.0,
                    'abstr_sim': 0.0, 'reason': 'doi',
                })

    report(15, 'DOI exacto completado…')

    # ── 2. Accession number exact match ─────────────────────
    if mode in ('id', 'both'):
        an_map: dict[str, list[int]] = {}
        for i, r in enumerate(refs):
            raw = (r.get('accession') or '').strip()
            if not raw:
                continue
            norm = raw.split(':')[-1].replace(' ', '').lower()
            if norm:
                an_map.setdefault(norm, []).append(i)
        for grp in an_map.values():
            if len(grp) < 2:
                continue
            for a in range(len(grp) - 1):
                for b in range(a + 1, len(grp)):
                    add_pair(grp[a], grp[b], {
                        'score': 1.0, 'title_sim': 0.0,
                        'abstr_sim': 0.0, 'reason': 'an',
                    })

    report(25, 'ID exacto completado…')

    if mode in ('text', 'both'):
        # ── 3. Journal + year exact match ───────────────────
        journal_map: dict[str, list[int]] = {}
        for i, r in enumerate(refs):
            j = normalize_str(r.get('journal') or '')
            y = (r.get('year') or '').strip()
            if j and len(j) >= 4 and y:
                journal_map.setdefault(f'{j}||{y}', []).append(i)

        jtok = [frozenset(tokenize(r.get('title') or '')) for r in refs]
        for grp in journal_map.values():
            if len(grp) < 2:
                continue
            for a in range(len(grp) - 1):
                for b in range(a + 1, len(grp)):
                    ts = jaccard(jtok[grp[a]], jtok[grp[b]])
                    if ts >= 0.70:
                        add_pair(grp[a], grp[b], {
                            'score': ts, 'title_sim': ts,
                            'abstr_sim': 0.0, 'reason': 'journal',
                        })

        report(35, 'Similitud por revista completada…')

        # ── 4. Sorted neighborhood text similarity ───────────
        tok = []
        for r in refs:
            abstr = r.get('abstract') or ''
            tok.append({
                'title_set':  frozenset(tokenize(r.get('title') or '')),
                'abstr_set':  frozenset(tokenize(abstr)) if len(abstr) > 50 else None,
                'norm_title': normalize_str(r.get('title') or ''),
            })

        order = sorted(range(n), key=lambda i: tok[i]['norm_title'])

        report(40, 'Comparando similitud de texto…')
        last_reported = 40

        for wi in range(n):
            i  = order[wi]
            ti = tok[i]
            if not ti['title_set']:
                continue

            end = min(wi + window_size + 1, n)
            for wj in range(wi + 1, end):
                j  = order[wj]
                tj = tok[j]
                if not tj['title_set']:
                    continue

                # Early exit: titles diverge too much
                if (prefix_ratio(ti['norm_title'], tj['norm_title']) < 0.05
                        and ti['norm_title'][:1] != tj['norm_title'][:1]):
                    break

                title_sim = jaccard(ti['title_set'], tj['title_set'])
                if title_sim < threshold * 0.55:
                    continue

                score     = title_sim
                abstr_sim = 0.0

                if title_sim >= threshold * 0.75 and ti['abstr_set'] and tj['abstr_set']:
                    abstr_sim = jaccard(ti['abstr_set'], tj['abstr_set'])
                    score     = title_sim * title_weight + abstr_sim * abstract_weight

                if score >= threshold:
                    reason = (
                        'title_abstract'
                        if abstr_sim >= 0.40 and title_sim >= threshold * 0.75
                        else 'title'
                    )
                    add_pair(i, j, {
                        'score': score, 'title_sim': title_sim,
                        'abstr_sim': abstr_sim, 'reason': reason,
                    })

            # Report progress every ~5 %
            pct = 40 + int((wi / max(n, 1)) * 55)
            if pct - last_reported >= 5:
                report(pct, f'Procesando referencias… {wi:,}/{n:,}')
                last_reported = pct

    report(95, 'Organizando resultados…')

    # ── 5. Collect groups ────────────────────────────────────
    comp_map: dict[int, list[int]] = {}
    for i in range(n):
        comp_map.setdefault(uf.find(i), []).append(i)

    groups = []
    for members in comp_map.values():
        if len(members) < 2:
            continue
        max_score  = 0.0
        group_pairs: list[dict] = []
        for a in range(len(members) - 1):
            for b in range(a + 1, len(members)):
                ka = min(members[a], members[b])
                kb = max(members[a], members[b])
                ps = pair_scores.get(f'{ka}-{kb}')
                if ps:
                    if ps['score'] > max_score:
                        max_score = ps['score']
                    group_pairs.append({'i': members[a], 'j': members[b], **ps})
        if max_score == 0:
            max_score = threshold
        groups.append({'members': members, 'pairs': group_pairs, 'max_score': max_score})

    groups.sort(key=lambda g: g['max_score'], reverse=True)
    report(100, '¡Listo!')

    return {'groups': groups, 'total_pairs': len(pair_scores)}
