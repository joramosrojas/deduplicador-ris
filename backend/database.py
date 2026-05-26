"""
PostgreSQL persistence layer.
Used when DATABASE_URL env var is set; otherwise session operations fall back to filesystem.
"""
import json
import os

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    from psycopg2.pool import ThreadedConnectionPool
    _HAS_PSYCOPG2 = True
except ImportError:
    _HAS_PSYCOPG2 = False

_pool = None


def available() -> bool:
    return _HAS_PSYCOPG2 and bool(os.environ.get('DATABASE_URL'))


def _get_pool():
    global _pool
    if _pool:
        return _pool
    url = os.environ['DATABASE_URL']
    if url.startswith('postgres://'):
        url = 'postgresql://' + url[len('postgres://'):]
    _pool = ThreadedConnectionPool(1, 10, url)
    return _pool


class _Conn:
    def __enter__(self):
        self._conn = _get_pool().getconn()
        return self._conn

    def __exit__(self, exc, *_):
        if exc:
            self._conn.rollback()
        else:
            self._conn.commit()
        _get_pool().putconn(self._conn)


def init_db():
    if not available():
        return
    with _Conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS sessions (
                    job_id        TEXT PRIMARY KEY,
                    name          TEXT,
                    mode          TEXT    DEFAULT 'massive',
                    created_at    TEXT,
                    filenames     JSONB   DEFAULT '[]',
                    total_refs    INTEGER DEFAULT 0,
                    total_groups  INTEGER DEFAULT 0,
                    response_cats JSONB   DEFAULT '{}',
                    refs          JSONB   DEFAULT '[]',
                    groups_data   JSONB   DEFAULT '[]',
                    cats          JSONB   DEFAULT '{}'
                );
                CREATE TABLE IF NOT EXISTS decisions (
                    job_id TEXT PRIMARY KEY
                           REFERENCES sessions(job_id) ON DELETE CASCADE,
                    data   JSONB DEFAULT '{}'
                );
            """)


def save_session(*, job_id, name, mode, created_at, filenames,
                 total_refs, total_groups, response_cats, refs, groups, cats):
    with _Conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO sessions
                    (job_id, name, mode, created_at, filenames,
                     total_refs, total_groups, response_cats,
                     refs, groups_data, cats)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (job_id) DO UPDATE SET
                    name          = EXCLUDED.name,
                    refs          = EXCLUDED.refs,
                    groups_data   = EXCLUDED.groups_data,
                    cats          = EXCLUDED.cats,
                    response_cats = EXCLUDED.response_cats,
                    total_refs    = EXCLUDED.total_refs,
                    total_groups  = EXCLUDED.total_groups
            """, (
                job_id, name, mode, created_at,
                json.dumps(filenames), total_refs, total_groups,
                json.dumps(response_cats),
                json.dumps(refs), json.dumps(groups), json.dumps(cats),
            ))


def load_session(job_id: str):
    with _Conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute('SELECT * FROM sessions WHERE job_id = %s', (job_id,))
            return cur.fetchone()


def list_sessions():
    with _Conn() as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""
                SELECT s.job_id, s.name, s.mode, s.created_at,
                       s.filenames, s.total_refs, s.total_groups, s.response_cats,
                       d.data AS decisions
                FROM   sessions s
                LEFT JOIN decisions d ON s.job_id = d.job_id
                ORDER  BY s.created_at DESC
            """)
            return [dict(r) for r in cur.fetchall()]


def get_decisions(job_id: str) -> dict:
    with _Conn() as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT data FROM decisions WHERE job_id = %s', (job_id,))
            row = cur.fetchone()
            return row[0] if row else {'batch': {}, 'groups': {}}


def save_decisions(job_id: str, data: dict):
    with _Conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO decisions (job_id, data) VALUES (%s, %s)
                ON CONFLICT (job_id) DO UPDATE SET data = EXCLUDED.data
            """, (job_id, json.dumps(data)))


def delete_session(job_id: str):
    with _Conn() as conn:
        with conn.cursor() as cur:
            cur.execute('DELETE FROM sessions WHERE job_id = %s', (job_id,))
