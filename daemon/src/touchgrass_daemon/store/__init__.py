"""SQLite-backed persistence layer."""

from .migrations import migrate
from .models import (
    Message,
    MessageRole,
    PermissionRequest,
    PermissionStatus,
    Session,
    SessionStatus,
)
from .store import DB_PATH_ENV_VAR, DEFAULT_DB_PATH, SessionStore, resolve_db_path

__all__ = [
    "DB_PATH_ENV_VAR",
    "DEFAULT_DB_PATH",
    "Message",
    "MessageRole",
    "PermissionRequest",
    "PermissionStatus",
    "Session",
    "SessionStatus",
    "SessionStore",
    "migrate",
    "resolve_db_path",
]
