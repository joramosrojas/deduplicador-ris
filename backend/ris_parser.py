"""
RIS / NBIB parser — Python port of ris-parser.js
Produces dicts with the same field names as the JS version.
"""
import re
import unicodedata
import uuid

RIS_TAG_MAP = {
    'TI': 'title',    'T1': 'title',    'CT': 'title',    'BT': 'title',
    'AB': 'abstract', 'N2': 'abstract',
    'AU': '_authors', 'A1': '_authors', 'A2': '_authors',
    'A3': '_authors', 'A4': '_authors',
    'PY': 'year',     'Y1': 'year',
    'JO': 'journal',  'JF': 'journal',  'JA': 'journal',
    'J1': 'journal',  'J2': 'journal',  'T2': 'journal',  'SO': 'journal',
    'DO': 'doi',      'M3': 'doi',
    'VL': 'volume',
    'IS': 'issue',
    'SP': 'start_page',
    'EP': 'end_page',
    'KW': '_keywords',
    'UR': 'url',      'LK': 'url',
    'PB': 'publisher',
    'SN': 'issn',
    'N1': 'notes',
    'AN': 'accession',
    'TY': 'type',
}

_TAG_RE = re.compile(r'^([A-Z][A-Z0-9])\s{2}-\s?(.*)')


def _normalize_doi(doi: str) -> str:
    doi = doi.lower().strip()
    doi = doi.replace('https://doi.org/', '').replace('http://doi.org/', '')
    return doi


def _new_ref(source_name: str) -> dict:
    return {
        'id':        'r' + uuid.uuid4().hex[:8],
        '_source':   source_name,
        '_authors':  [],
        '_keywords': [],
    }


def _finalize(ref: dict) -> dict:
    ref['authors']  = '; '.join(ref.pop('_authors',  []))
    ref['keywords'] = '; '.join(ref.pop('_keywords', []))
    if ref.get('doi'):
        ref['doi'] = _normalize_doi(ref['doi'])
    if ref.get('year'):
        ref['year'] = str(ref['year'])[:4]
    return ref


def parse_ris(text: str, source_name: str = '') -> list[dict]:
    refs = []
    current = None
    last_tag = None

    for line in text.splitlines():
        m = _TAG_RE.match(line)
        if m:
            tag, value = m.group(1), m.group(2).strip()
            last_tag = tag

            if tag == 'TY':
                if current is not None:
                    refs.append(_finalize(current))
                current = _new_ref(source_name)
                current['type'] = value
            elif tag == 'ER':
                if current is not None:
                    refs.append(_finalize(current))
                current = None
                last_tag = None
            elif current is not None:
                field = RIS_TAG_MAP.get(tag)
                if field in ('_authors', '_keywords'):
                    current[field].append(value)
                elif field == 'abstract':
                    current['abstract'] = (current.get('abstract') or '') + (' ' if current.get('abstract') else '') + value
                elif field:
                    current[field] = value
        elif current is not None and last_tag == 'AB' and (line.startswith('  ') or line.startswith('\t')):
            current['abstract'] = (current.get('abstract') or '') + ' ' + line.strip()

    if current is not None:
        refs.append(_finalize(current))
    return refs


def parse_nbib(text: str, source_name: str = '') -> list[dict]:
    refs = []
    current = None
    last_tag = None
    _NBIB_TAG_RE = re.compile(r'^([A-Z]+)\s*-\s(.*)')

    for line in text.splitlines():
        if not line.strip():
            if current is not None:
                refs.append(_finalize(current))
            current = None
            last_tag = None
            continue

        m = _NBIB_TAG_RE.match(line)
        if m:
            tag, value = m.group(1), m.group(2).strip()
            last_tag = tag

            if tag == 'PMID':
                if current is not None:
                    refs.append(_finalize(current))
                current = _new_ref(source_name)
                current['accession'] = value.strip()
            elif current is None:
                continue
            elif tag == 'TI':
                current['title'] = value
            elif tag == 'AB':
                current['abstract'] = value
            elif tag == 'AU':
                current['_authors'].append(value)
            elif tag == 'DP':
                ym = re.match(r'(\d{4})', value)
                if ym:
                    current['year'] = ym.group(1)
            elif tag in ('JT', 'TA'):
                if not current.get('journal'):
                    current['journal'] = value
            elif tag == 'VI':
                current['volume'] = value
            elif tag == 'IP':
                current['issue'] = value
            elif tag == 'PG':
                parts = value.split('-', 1)
                current['start_page'] = parts[0].strip()
                if len(parts) > 1:
                    current['end_page'] = parts[1].strip()
            elif tag in ('AID', 'LID'):
                dm = re.search(r'(10\.\S+)\s+\[doi\]', value)
                if dm:
                    current['doi'] = _normalize_doi(dm.group(1))
            elif tag in ('MH', 'OT'):
                current['_keywords'].append(value.rstrip('.'))
            elif tag == 'IS':
                current['issn'] = value
            elif tag == 'PT':
                current['pubtype'] = value
        elif current is not None and line.startswith((' ', '\t')):
            val = line.strip()
            if last_tag == 'TI':
                current['title'] = (current.get('title') or '') + ' ' + val
            elif last_tag == 'AB':
                current['abstract'] = (current.get('abstract') or '') + ' ' + val

    if current is not None:
        refs.append(_finalize(current))
    return refs


def detect_format(text: str) -> str:
    first = text.lstrip()[:20]
    if re.match(r'^PMID-?\s', first, re.IGNORECASE):
        return 'nbib'
    return 'ris'


_RIS_FIELD_MAP = [
    ('title',      'TI'),
    ('abstract',   'AB'),
    ('year',       'PY'),
    ('journal',    'JO'),
    ('doi',        'DO'),
    ('volume',     'VL'),
    ('issue',      'IS'),
    ('start_page', 'SP'),
    ('end_page',   'EP'),
    ('url',        'UR'),
    ('publisher',  'PB'),
    ('issn',       'SN'),
    ('notes',      'N1'),
    ('accession',  'AN'),
]


def refs_to_ris(refs: list[dict]) -> str:
    lines = []
    for ref in refs:
        lines.append(f"TY  - {ref.get('type', 'JOUR')}")
        for author in (ref.get('authors') or '').split('; '):
            if author.strip():
                lines.append(f'AU  - {author.strip()}')
        for field, tag in _RIS_FIELD_MAP:
            val = ref.get(field)
            if val:
                lines.append(f'{tag}  - {val}')
        for kw in (ref.get('keywords') or '').split('; '):
            if kw.strip():
                lines.append(f'KW  - {kw.strip()}')
        lines.append('ER  - ')
        lines.append('')
    return '\r\n'.join(lines)
