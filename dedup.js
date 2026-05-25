/* =========================================================
   DEDUPLICATION ENGINE — dedup.js
   Algoritmo: DOI exact match + Sorted Neighborhood (Jaccard)
   Complejidad: O(n × W)  →  manejable para 30 000 referencias
   ========================================================= */

const STOP_WORDS = new Set([
  // English
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
  // Spanish
  'de','la','el','los','las','en','y','o','a','un','una','unos','unas','del','al',
  'por','para','con','sin','sobre','entre','bajo','desde','hasta','según','durante',
  'aunque','porque','como','cuando','donde','quien','cuyo','cual','que','se','su','sus',
  'este','esta','estos','estas','ese','esa','esos','esas','más','muy','todo','todos',
  'toda','todas','otro','otra','otros','otras','mismo','misma','ya','así','hay','son',
  'fue','era','tiene','puede','estudio','estudios','pacientes','resultados','métodos',
  'objetivo','conclusión','revisión','sistemática','análisis','efecto','efectos',
]);

function normalizeStr(text) {
  return (text || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return normalizeStr(text)
    .split(' ')
    .filter(w => w.length > 2 && !STOP_WORDS.has(w) && !/^\d{1,3}$/.test(w));
}

function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  const [sm, lg] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let inter = 0;
  for (const w of sm) if (lg.has(w)) inter++;
  return inter / (setA.size + setB.size - inter);
}

// Fast prefix similarity: ratio of shared leading characters (for early exit)
function prefixRatio(a, b) {
  const len = Math.min(a.length, b.length, 20);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i / Math.max(a.length, b.length, 1);
}

class UnionFind {
  constructor(n) {
    this.p = Array.from({ length: n }, (_, i) => i);
    this.r = new Int8Array(n);
  }
  find(x) {
    while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; }
    return x;
  }
  union(x, y) {
    const px = this.find(x), py = this.find(y);
    if (px === py) return false;
    if (this.r[px] < this.r[py]) this.p[px] = py;
    else if (this.r[px] > this.r[py]) this.p[py] = px;
    else { this.p[py] = px; this.r[px]++; }
    return true;
  }
}

/**
 * Main deduplication function.
 * @param {Array} refs  - parsed references
 * @param {Object} opts - { threshold, titleWeight, abstractWeight, windowSize }
 * @returns {{ groups: Array, totalPairs: number }}
 */
function runDedup(refs, opts = {}) {
  const {
    threshold      = 0.82,
    titleWeight    = 0.80,
    abstractWeight = 0.20,
    windowSize     = 80,
    mode           = 'both',   // 'id' | 'text' | 'both'
  } = opts;

  const n = refs.length;
  const uf = new UnionFind(n);
  const pairScores = new Map(); // "i-j" → score

  const REASON_PRIO = { doi: 0, an: 1, title_abstract: 2, title: 3, journal: 4 };
  function addPair(a, b, data) {
    uf.union(a, b);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    const key = `${lo}-${hi}`;
    const existing = pairScores.get(key);
    if (!existing) { pairScores.set(key, data); return; }
    const ep = REASON_PRIO[existing.reason] ?? 99;
    const np = REASON_PRIO[data.reason]    ?? 99;
    if (np < ep || (np === ep && data.score > existing.score))
      pairScores.set(key, data);
  }

  // ── 1. DOI exact match (always) ──────────────────────────
  const doiMap = new Map();
  refs.forEach((r, i) => {
    if (r.doi) {
      const d = r.doi.toLowerCase().trim();
      if (!doiMap.has(d)) doiMap.set(d, []);
      doiMap.get(d).push(i);
    }
  });
  doiMap.forEach(group => {
    for (let a = 0; a < group.length - 1; a++)
      for (let b = a + 1; b < group.length; b++)
        addPair(group[a], group[b], { score: 1.0, titleSim: 1.0, abstrSim: 0, reason: 'doi' });
  });

  // ── 2. Accession Number / External ID exact match ────────
  if (mode === 'id' || mode === 'both') {
    const anMap = new Map();
    refs.forEach((r, i) => {
      const raw = (r.accession || '').trim();
      if (!raw) return;
      // Some databases prefix AN with DB name (e.g. "2024123456" or "EMBASE:2024123456")
      // Normalize: strip prefix up to colon, lowercase, trim
      const parts = raw.split(':');
      const norm = parts[parts.length - 1].replace(/\s/g, '').toLowerCase();
      if (!norm) return;
      if (!anMap.has(norm)) anMap.set(norm, []);
      anMap.get(norm).push(i);
    });
    anMap.forEach(group => {
      if (group.length < 2) return;
      for (let a = 0; a < group.length - 1; a++)
        for (let b = a + 1; b < group.length; b++)
          addPair(group[a], group[b], { score: 1.0, titleSim: 0, abstrSim: 0, reason: 'an' });
    });
  }

  // ── 3. Journal + year exact match (same venue, similar title) ──
  if (mode === 'text' || mode === 'both') {
    const journalMap = new Map();
    refs.forEach((r, i) => {
      const j = normalizeStr(r.journal || '');
      const y = (r.year || '').trim();
      if (!j || j.length < 4 || !y) return;
      const key = `${j}||${y}`;
      if (!journalMap.has(key)) journalMap.set(key, []);
      journalMap.get(key).push(i);
    });
    const journalTok = refs.map(r => new Set(tokenize(r.title || '')));
    journalMap.forEach(group => {
      if (group.length < 2) return;
      for (let a = 0; a < group.length - 1; a++) {
        for (let b = a + 1; b < group.length; b++) {
          const tSim = jaccard(journalTok[group[a]], journalTok[group[b]]);
          if (tSim >= 0.70) {
            addPair(group[a], group[b], { score: tSim, titleSim: tSim, abstrSim: 0, reason: 'journal' });
          }
        }
      }
    });
  }

  // ── 4. Text-based similarity (sliding window) ───────────
  if (mode === 'text' || mode === 'both') {
  const tok = refs.map(r => ({
    titleSet:   new Set(tokenize(r.title || '')),
    abstrSet:   r.abstract && r.abstract.length > 50
                  ? new Set(tokenize(r.abstract))
                  : null,
    normTitle:  normalizeStr(r.title || ''),
  }));

  const order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => tok[a].normTitle.localeCompare(tok[b].normTitle));

  for (let wi = 0; wi < n; wi++) {
    const i = order[wi];
    const ti = tok[i];
    if (!ti.titleSet.size) continue;

    const end = Math.min(wi + windowSize + 1, n);
    for (let wj = wi + 1; wj < end; wj++) {
      const j = order[wj];
      const tj = tok[j];
      if (!tj.titleSet.size) continue;

      if (prefixRatio(ti.normTitle, tj.normTitle) < 0.05 && ti.normTitle[0] !== tj.normTitle[0]) break;

      const titleSim = jaccard(ti.titleSet, tj.titleSet);
      if (titleSim < threshold * 0.55) continue;

      let score = titleSim;
      let abstrSim = 0;

      if (titleSim >= threshold * 0.75 && ti.abstrSet && tj.abstrSet) {
        abstrSim = jaccard(ti.abstrSet, tj.abstrSet);
        score = titleSim * titleWeight + abstrSim * abstractWeight;
      }

      if (score >= threshold) {
        // Assign granular reason based on what matched
        let reason;
        if (abstrSim >= 0.40 && titleSim >= threshold * 0.75) reason = 'title_abstract';
        else                                                    reason = 'title';
        addPair(i, j, { score, titleSim, abstrSim, reason });
      }
    }
  }
  } // end mode text/both

  // ── 5. Collect groups ────────────────────────────────────
  const compMap = new Map();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!compMap.has(root)) compMap.set(root, []);
    compMap.get(root).push(i);
  }

  const groups = [];
  compMap.forEach(members => {
    if (members.length < 2) return;

    // Compute representative score for the group
    let maxScore = 0;
    const groupPairs = [];
    for (let a = 0; a < members.length - 1; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const ka = Math.min(members[a], members[b]);
        const kb = Math.max(members[a], members[b]);
        const ps = pairScores.get(`${ka}-${kb}`);
        if (ps) {
          if (ps.score > maxScore) maxScore = ps.score;
          groupPairs.push({ i: members[a], j: members[b], ...ps });
        }
      }
    }
    if (maxScore === 0) maxScore = threshold;
    groups.push({ members, pairs: groupPairs, maxScore });
  });

  groups.sort((a, b) => b.maxScore - a.maxScore);

  return { groups, totalPairs: pairScores.size };
}
