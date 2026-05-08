"""Synchronous SQLite-backed store for sessions, messages, and permission requests.

Single-process daemon, single shared connection, internal lock. Async callers should
wrap calls in `asyncio.to_thread` — these methods are blocking. SQLite WAL mode keeps
concurrent reads cheap.
"""

from __future__ import annotations

import os
import sqlite3
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path

from .migrations import migrate
from .models import (
    Message,
    MessageRole,
    PermissionRequest,
    PermissionStatus,
    Session,
    SessionStatus,
)

DEFAULT_DB_PATH = Path("~/.touchgrass/touchgrass.db")
DB_PATH_ENV_VAR = "TOUCHGRASS_DB_PATH"


def _now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="microseconds")


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value)


def resolve_db_path(override: Path | None = None) -> Path:
    """Pick the DB path: explicit override > env var > default."""
    if override is not None:
        return override.expanduser()
    env = os.environ.get(DB_PATH_ENV_VAR)
    if env:
        return Path(env).expanduser()
    return DEFAULT_DB_PATH.expanduser()


class SessionStore:
    def __init__(self, db_path: Path | None = None) -> None:
        self._path = resolve_db_path(db_path)
        migrate(self._path)
        self._conn = sqlite3.connect(self._path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA foreign_keys = ON")
        self._conn.execute("PRAGMA journal_mode = WAL")
        self._lock = threading.RLock()

    @property
    def path(self) -> Path:
        return self._path

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    # --- Sessions --------------------------------------------------------------

    def create_session(
        self,
        project_name: str,
        goal: str | None = None,
        *,
        session_id: str | None = None,
    ) -> Session:
        sid = session_id or str(uuid.uuid4())
        created_at = _now_iso()
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO sessions (id, project_name, goal, status, created_at) "
                "VALUES (?, ?, ?, 'active', ?)",
                (sid, project_name, goal, created_at),
            )
        return Session(
            id=sid,
            project_name=project_name,
            goal=goal,
            status="active",
            created_at=_parse_iso(created_at),
        )

    def get_session(self, session_id: str) -> Session | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, project_name, goal, status, created_at FROM sessions WHERE id = ?",
                (session_id,),
            ).fetchone()
        return _row_to_session(row) if row else None

    def list_sessions(self, project_name: str | None = None) -> list[Session]:
        with self._lock:
            if project_name is None:
                rows = self._conn.execute(
                    "SELECT id, project_name, goal, status, created_at "
                    "FROM sessions ORDER BY created_at DESC"
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT id, project_name, goal, status, created_at "
                    "FROM sessions WHERE project_name = ? ORDER BY created_at DESC",
                    (project_name,),
                ).fetchall()
        return [_row_to_session(row) for row in rows]

    def update_session_status(self, session_id: str, status: SessionStatus) -> None:
        with self._lock, self._conn:
            cursor = self._conn.execute(
                "UPDATE sessions SET status = ? WHERE id = ?", (status, session_id)
            )
        if cursor.rowcount == 0:
            raise KeyError(f"session not found: {session_id}")

    # --- Messages --------------------------------------------------------------

    def append_message(
        self,
        session_id: str,
        role: MessageRole,
        content: str,
        *,
        tool_name: str | None = None,
        tool_args: str | None = None,
    ) -> Message:
        created_at = _now_iso()
        with self._lock, self._conn:
            cursor = self._conn.execute(
                "INSERT INTO messages "
                "(session_id, role, content, tool_name, tool_args, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (session_id, role, content, tool_name, tool_args, created_at),
            )
            new_id = cursor.lastrowid
            assert new_id is not None
        return Message(
            id=new_id,
            session_id=session_id,
            role=role,
            content=content,
            tool_name=tool_name,
            tool_args=tool_args,
            created_at=_parse_iso(created_at),
        )

    def get_messages(
        self,
        session_id: str,
        *,
        limit: int | None = None,
        before_id: int | None = None,
    ) -> list[Message]:
        """Return messages for a session in ascending id order.

        `before_id` returns rows with id strictly less than `before_id` — pair with
        `limit` for backward pagination ("give me the previous N messages").
        """
        clauses = ["session_id = ?"]
        params: list[object] = [session_id]
        if before_id is not None:
            clauses.append("id < ?")
            params.append(before_id)
        sql = (
            "SELECT id, session_id, role, content, tool_name, tool_args, created_at "
            f"FROM messages WHERE {' AND '.join(clauses)} ORDER BY id ASC"
        )
        if limit is not None:
            # Apply limit to the most recent N (descending), then re-sort ascending.
            sql = (
                "SELECT id, session_id, role, content, tool_name, tool_args, created_at "
                f"FROM messages WHERE {' AND '.join(clauses)} "
                "ORDER BY id DESC LIMIT ?"
            )
            params.append(limit)
            with self._lock:
                rows = list(reversed(self._conn.execute(sql, params).fetchall()))
        else:
            with self._lock:
                rows = self._conn.execute(sql, params).fetchall()
        return [_row_to_message(row) for row in rows]

    # --- Permission requests ---------------------------------------------------

    def create_permission_request(
        self,
        session_id: str,
        tool_name: str,
        tool_args: str,
        *,
        request_id: str | None = None,
    ) -> PermissionRequest:
        rid = request_id or str(uuid.uuid4())
        created_at = _now_iso()
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO permission_requests "
                "(id, session_id, tool_name, tool_args, status, created_at) "
                "VALUES (?, ?, ?, ?, 'pending', ?)",
                (rid, session_id, tool_name, tool_args, created_at),
            )
        return PermissionRequest(
            id=rid,
            session_id=session_id,
            tool_name=tool_name,
            tool_args=tool_args,
            status="pending",
            created_at=_parse_iso(created_at),
            resolved_at=None,
        )

    def resolve_permission_request(
        self, request_id: str, status: PermissionStatus
    ) -> None:
        if status == "pending":
            raise ValueError("cannot resolve a request to 'pending'")
        resolved_at = _now_iso()
        with self._lock, self._conn:
            cursor = self._conn.execute(
                "UPDATE permission_requests SET status = ?, resolved_at = ? "
                "WHERE id = ? AND status = 'pending'",
                (status, resolved_at, request_id),
            )
        if cursor.rowcount == 0:
            raise KeyError(f"no pending permission request with id: {request_id}")

    def get_permission_request(self, request_id: str) -> PermissionRequest | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT id, session_id, tool_name, tool_args, status, created_at, resolved_at "
                "FROM permission_requests WHERE id = ?",
                (request_id,),
            ).fetchone()
        return _row_to_permission(row) if row else None

    # --- File summaries cache --------------------------------------------------

    def get_file_summary(
        self, project_name: str, path: str
    ) -> tuple[float, str] | None:
        """Return `(file_mtime, summary)` or None. Caller compares mtime to disk
        and decides cache hit vs invalidation."""
        with self._lock:
            row = self._conn.execute(
                "SELECT file_mtime, summary FROM file_summaries "
                "WHERE project_name = ? AND path = ?",
                (project_name, path),
            ).fetchone()
        if row is None:
            return None
        return float(row["file_mtime"]), row["summary"]

    def upsert_file_summary(
        self, project_name: str, path: str, file_mtime: float, summary: str
    ) -> None:
        created_at = _now_iso()
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO file_summaries "
                "(project_name, path, file_mtime, summary, created_at) "
                "VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(project_name, path) DO UPDATE SET "
                "file_mtime = excluded.file_mtime, "
                "summary = excluded.summary, "
                "created_at = excluded.created_at",
                (project_name, path, file_mtime, summary, created_at),
            )

    def list_pending_permission_requests(self) -> list[PermissionRequest]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, session_id, tool_name, tool_args, status, created_at, resolved_at "
                "FROM permission_requests WHERE status = 'pending' ORDER BY created_at ASC"
            ).fetchall()
        return [_row_to_permission(row) for row in rows]


def _row_to_session(row: sqlite3.Row) -> Session:
    return Session(
        id=row["id"],
        project_name=row["project_name"],
        goal=row["goal"],
        status=row["status"],
        created_at=_parse_iso(row["created_at"]),
    )


def _row_to_message(row: sqlite3.Row) -> Message:
    return Message(
        id=row["id"],
        session_id=row["session_id"],
        role=row["role"],
        content=row["content"],
        tool_name=row["tool_name"],
        tool_args=row["tool_args"],
        created_at=_parse_iso(row["created_at"]),
    )


def _row_to_permission(row: sqlite3.Row) -> PermissionRequest:
    return PermissionRequest(
        id=row["id"],
        session_id=row["session_id"],
        tool_name=row["tool_name"],
        tool_args=row["tool_args"],
        status=row["status"],
        created_at=_parse_iso(row["created_at"]),
        resolved_at=_parse_iso(row["resolved_at"]) if row["resolved_at"] else None,
    )
