from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from touchgrass_daemon.store import DB_PATH_ENV_VAR, SessionStore, migrate, resolve_db_path


@pytest.fixture
def store(tmp_path: Path) -> Iterator[SessionStore]:
    s = SessionStore(tmp_path / "test.db")
    yield s
    s.close()


def test_migrate_creates_schema(tmp_path: Path) -> None:
    db = tmp_path / "fresh.db"
    version = migrate(db)
    assert version == 2
    with sqlite3.connect(db) as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
    assert {"schema_version", "sessions", "messages", "permission_requests"} <= tables


def test_migrate_is_idempotent(tmp_path: Path) -> None:
    db = tmp_path / "twice.db"
    assert migrate(db) == 2
    assert migrate(db) == 2


def test_resolve_db_path_env_var(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv(DB_PATH_ENV_VAR, str(tmp_path / "via-env.db"))
    assert resolve_db_path() == tmp_path / "via-env.db"


def test_resolve_db_path_override_wins(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv(DB_PATH_ENV_VAR, str(tmp_path / "via-env.db"))
    explicit = tmp_path / "explicit.db"
    assert resolve_db_path(explicit) == explicit


def test_create_and_get_session(store: SessionStore) -> None:
    session = store.create_session("my-app", goal="fix the auth bug")
    assert session.project_name == "my-app"
    assert session.goal == "fix the auth bug"
    assert session.status == "active"

    fetched = store.get_session(session.id)
    assert fetched == session


def test_get_session_returns_none_for_unknown(store: SessionStore) -> None:
    assert store.get_session("nope") is None


def test_list_sessions_filters_by_project(store: SessionStore) -> None:
    store.create_session("alpha", goal="a")
    store.create_session("beta", goal="b")
    store.create_session("alpha", goal="c")

    all_sessions = store.list_sessions()
    assert len(all_sessions) == 3

    alpha_only = store.list_sessions("alpha")
    assert {s.goal for s in alpha_only} == {"a", "c"}


def test_update_session_status(store: SessionStore) -> None:
    session = store.create_session("app")
    store.update_session_status(session.id, "completed")
    fetched = store.get_session(session.id)
    assert fetched is not None
    assert fetched.status == "completed"


def test_update_session_status_unknown_raises(store: SessionStore) -> None:
    with pytest.raises(KeyError):
        store.update_session_status("nope", "completed")


def test_append_and_get_messages_in_order(store: SessionStore) -> None:
    session = store.create_session("app")
    store.append_message(session.id, "user", "hello")
    store.append_message(session.id, "assistant", "hi there")
    store.append_message(session.id, "tool_call", "read", tool_name="Read", tool_args='{}')

    messages = store.get_messages(session.id)
    assert [m.content for m in messages] == ["hello", "hi there", "read"]
    assert messages[2].tool_name == "Read"
    assert messages[2].tool_args == "{}"
    assert all(m.session_id == session.id for m in messages)


def test_get_messages_pagination_limit_returns_most_recent(store: SessionStore) -> None:
    session = store.create_session("app")
    for i in range(5):
        store.append_message(session.id, "user", f"msg-{i}")

    last_two = store.get_messages(session.id, limit=2)
    assert [m.content for m in last_two] == ["msg-3", "msg-4"]


def test_get_messages_before_id(store: SessionStore) -> None:
    session = store.create_session("app")
    ids = [
        store.append_message(session.id, "user", f"m-{i}").id for i in range(5)
    ]
    earlier = store.get_messages(session.id, before_id=ids[3])
    assert [m.id for m in earlier] == ids[:3]


def test_persists_across_store_instances(tmp_path: Path) -> None:
    db = tmp_path / "persist.db"
    s1 = SessionStore(db)
    session = s1.create_session("app", goal="persisted goal")
    s1.append_message(session.id, "user", "hi")
    s1.close()

    s2 = SessionStore(db)
    fetched = s2.get_session(session.id)
    assert fetched is not None
    assert fetched.goal == "persisted goal"
    assert [m.content for m in s2.get_messages(session.id)] == ["hi"]
    s2.close()


def test_permission_request_lifecycle(store: SessionStore) -> None:
    session = store.create_session("app")
    req = store.create_permission_request(session.id, "Bash", '{"cmd":"ls"}')
    assert req.status == "pending"
    assert store.list_pending_permission_requests() == [req]

    store.resolve_permission_request(req.id, "allowed_once")
    refreshed = store.get_permission_request(req.id)
    assert refreshed is not None
    assert refreshed.status == "allowed_once"
    assert refreshed.resolved_at is not None
    assert store.list_pending_permission_requests() == []


def test_resolve_unknown_request_raises(store: SessionStore) -> None:
    with pytest.raises(KeyError):
        store.resolve_permission_request("missing", "denied")


def test_resolve_already_resolved_raises(store: SessionStore) -> None:
    session = store.create_session("app")
    req = store.create_permission_request(session.id, "Bash", "{}")
    store.resolve_permission_request(req.id, "denied")
    with pytest.raises(KeyError):
        store.resolve_permission_request(req.id, "allowed_once")


def test_resolve_to_pending_rejected(store: SessionStore) -> None:
    session = store.create_session("app")
    req = store.create_permission_request(session.id, "Bash", "{}")
    with pytest.raises(ValueError, match="pending"):
        store.resolve_permission_request(req.id, "pending")


def test_cascade_delete_messages_and_permissions(store: SessionStore) -> None:
    session = store.create_session("app")
    store.append_message(session.id, "user", "hi")
    store.create_permission_request(session.id, "Bash", "{}")

    store._conn.execute("DELETE FROM sessions WHERE id = ?", (session.id,))
    store._conn.commit()

    assert store.get_messages(session.id) == []
    assert store.list_pending_permission_requests() == []
