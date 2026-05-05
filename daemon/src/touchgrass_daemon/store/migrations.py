"""Hand-rolled SQL migration runner.

Applies any `NNNN_*.sql` files in `migrations/` whose number exceeds the current
`schema_version`. Each migration runs in a transaction, in filename order, and is
expected to update `schema_version` itself if it changes the schema (the initial
migration creates the table and seeds it).
"""

from __future__ import annotations

import re
import sqlite3
from importlib import resources
from pathlib import Path

_MIGRATION_PATTERN = re.compile(r"^(\d{4})_.+\.sql$")


def _migration_files() -> list[tuple[int, str, str]]:
    """Return a sorted list of `(number, filename, sql_text)` tuples."""
    package = resources.files(__package__).joinpath("migrations")
    out: list[tuple[int, str, str]] = []
    for entry in package.iterdir():
        match = _MIGRATION_PATTERN.match(entry.name)
        if not match:
            continue
        number = int(match.group(1))
        out.append((number, entry.name, entry.read_text()))
    out.sort(key=lambda row: row[0])
    return out


def _current_version(conn: sqlite3.Connection) -> int:
    cursor = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    )
    if cursor.fetchone() is None:
        return 0
    row = conn.execute("SELECT version FROM schema_version").fetchone()
    return int(row[0]) if row else 0


def migrate(db_path: Path) -> int:
    """Apply all pending migrations to the DB at `db_path`. Returns the new version."""
    db_path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(db_path) as conn:
        conn.execute("PRAGMA foreign_keys = ON")
        current = _current_version(conn)
        for number, filename, sql in _migration_files():
            if number <= current:
                continue
            try:
                conn.executescript(sql)
                # If the migration didn't update schema_version itself, do it for them.
                row = conn.execute("SELECT version FROM schema_version").fetchone()
                if row is None or int(row[0]) < number:
                    conn.execute("DELETE FROM schema_version")
                    conn.execute(
                        "INSERT INTO schema_version (version) VALUES (?)", (number,)
                    )
                conn.commit()
            except sqlite3.Error as exc:
                conn.rollback()
                raise RuntimeError(f"migration {filename} failed: {exc}") from exc
            current = number
        return current
