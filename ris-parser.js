/* =========================================================
   RIS PARSER — ris-parser.js
   ========================================================= */

const RIS_TAG_MAP = {
  TI:'title', T1:'title', CT:'title', BT:'title',
  AU:'_authors', A1:'_authors', A2:'_authors', A3:'_authors', A4:'_authors',
  AB:'abstract', N2:'abstract',
  PY:'year', Y1:'year',
  JO:'journal', JF:'journal', JA:'journal', J1:'journal', J2:'journal',
  T2:'journal', SO:'journal',
  DO:'doi', M3:'doi',
  VL:'volume', IS:'issue', SP:'start_page', EP:'end_page',
  KW:'_keywords',
  TY:'type',
  UR:'url', LK:'url',
  PB:'publisher',
  SN:'issn',
  N1:'notes',
  AN:'accession',
};

function parseRIS(text, sourceFile) {
  const refs = [];
  let cur = null, lastTag = null;
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  for (const raw of lines) {
    const line = raw.trimEnd();
    const m = line.match(/^([A-Z][A-Z0-9])\s{0,2}-\s*(.*)$/);
    if (m) {
      const [, tag, val] = m;
      lastTag = tag;
      if (tag === 'TY') {
        cur = { _authors: [], _keywords: [], type: val.trim(), _source: sourceFile || '' };
      } else if (tag === 'ER') {
        if (cur) {
          cur.authors  = cur._authors.join('; ');
          cur.keywords = cur._keywords.join('; ');
          delete cur._authors; delete cur._keywords;
          cur.id = 'r' + Math.random().toString(36).slice(2, 10);
          refs.push(cur);
          cur = null;
        }
        lastTag = null;
      } else if (cur) {
        const field = RIS_TAG_MAP[tag];
        if (!field) continue;
        if (field === '_authors' || field === '_keywords') {
          cur[field].push(val.trim());
        } else if (field === 'year') {
          if (!cur.year) cur.year = val.trim().slice(0, 4);
        } else if (field === 'doi') {
          if (!cur.doi) cur.doi = val.trim().replace(/^https?:\/\/doi\.org\//i, '').toLowerCase();
        } else if (field === 'abstract') {
          cur.abstract = (cur.abstract ? cur.abstract + ' ' : '') + val.trim();
        } else {
          if (!cur[field]) cur[field] = val.trim();
        }
      }
    } else if (cur && lastTag === 'AB' && line.trim()) {
      cur.abstract = (cur.abstract || '') + ' ' + line.trim();
    }
  }
  return refs;
}

/* =========================================================
   NBIB PARSER (PubMed format)
   ========================================================= */
function parseNBIB(text, sourceFile) {
  const refs = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  let cur = null;
  let lastField = null;

  function saveRef() {
    if (!cur) return;
    cur.authors  = (cur._authors  || []).join('; ');
    cur.keywords = (cur._keywords || []).join('; ');
    delete cur._authors; delete cur._keywords;
    cur.id = 'r' + Math.random().toString(36).slice(2, 10);
    refs.push(cur);
    cur = null; lastField = null;
  }

  for (const raw of lines) {
    const line = raw.trimEnd();

    // Blank line = end of record
    if (!line.trim()) { saveRef(); continue; }

    // Continuation line (starts with spaces/tab and lastField exists)
    if (/^\s+/.test(line) && cur && lastField) {
      const val = line.trim();
      if (lastField === 'abstract') cur.abstract = (cur.abstract || '') + ' ' + val;
      else if (lastField === 'title') cur.title   = (cur.title   || '') + ' ' + val;
      continue;
    }

    // New field: "XX  - value" or "XX - value" (2-4 char tag)
    const m = line.match(/^([A-Z0-9]{2,4})\s{0,2}-\s*(.*)$/);
    if (!m) continue;
    const [, tag, val] = m;

    if (tag === 'PMID') {
      saveRef();
      cur = { type: 'JOUR', _authors: [], _keywords: [], _source: sourceFile || '' };
      cur.accession = val.trim();
      lastField = 'accession';
      continue;
    }

    if (!cur) continue;

    switch (tag) {
      case 'TI':
        cur.title = val.trim(); lastField = 'title'; break;
      case 'AB':
        cur.abstract = (cur.abstract ? cur.abstract + ' ' : '') + val.trim();
        lastField = 'abstract'; break;
      case 'AU':
        cur._authors.push(val.trim()); lastField = null; break;
      case 'FAU':
        // Full author name — use if AU not present yet for this author
        // FAU comes before AU, so only add if no matching short form yet
        break;
      case 'DP':
        if (!cur.year) cur.year = val.trim().slice(0, 4); lastField = null; break;
      case 'JT':
        if (!cur.journal) cur.journal = val.trim(); lastField = null; break;
      case 'TA':
        if (!cur.journal) cur.journal = val.trim(); lastField = null; break;
      case 'VI':
        cur.volume = val.trim(); lastField = null; break;
      case 'IP':
        cur.issue = val.trim(); lastField = null; break;
      case 'PG': {
        const pg = val.trim().split('-');
        cur.start_page = pg[0];
        if (pg[1]) cur.end_page = pg[1];
        lastField = null; break;
      }
      case 'AID':
      case 'LID': {
        // "10.1234/xxx [doi]"
        const dm = val.match(/^(.+)\s+\[doi\]/i);
        if (dm && !cur.doi) cur.doi = dm[1].trim().toLowerCase();
        lastField = null; break;
      }
      case 'MH':
      case 'OT':
        cur._keywords.push(val.trim()); lastField = null; break;
      case 'IS':
        if (!cur.issn) cur.issn = val.trim().split(' ')[0]; lastField = null; break;
      case 'PT':
        if (!cur.pubtype) cur.pubtype = val.trim(); lastField = null; break;
      default:
        lastField = null; break;
    }
  }
  saveRef();
  return refs;
}

function refsToRIS(refs) {
  return refs.map(r => {
    const L = [];
    L.push(`TY  - ${r.type || 'JOUR'}`);
    if (r.title)     L.push(`TI  - ${r.title}`);
    if (r.authors)   r.authors.split(';').forEach(a => a.trim() && L.push(`AU  - ${a.trim()}`));
    if (r.year)      L.push(`PY  - ${r.year}`);
    if (r.journal)   L.push(`JO  - ${r.journal}`);
    if (r.volume)    L.push(`VL  - ${r.volume}`);
    if (r.issue)     L.push(`IS  - ${r.issue}`);
    if (r.start_page)L.push(`SP  - ${r.start_page}`);
    if (r.end_page)  L.push(`EP  - ${r.end_page}`);
    if (r.abstract)  L.push(`AB  - ${r.abstract}`);
    if (r.doi)       L.push(`DO  - ${r.doi}`);
    if (r.url)       L.push(`UR  - ${r.url}`);
    if (r.keywords)  r.keywords.split(';').forEach(k => k.trim() && L.push(`KW  - ${k.trim()}`));
    if (r.issn)      L.push(`SN  - ${r.issn}`);
    if (r.notes)     L.push(`N1  - ${r.notes}`);
    if (r.publisher) L.push(`PB  - ${r.publisher}`);
    L.push('ER  - ');
    return L.join('\n');
  }).join('\n\n');
}
