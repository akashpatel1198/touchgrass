from __future__ import annotations

import asyncio
from collections.abc import Iterator
from pathlib import Path

import pytest
from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

from touchgrass_daemon.config import Config
from touchgrass_daemon.events import Event
from touchgrass_daemon.notifications import NtfyClient
from touchgrass_daemon.permissions import PermissionBroker
from touchgrass_daemon.store import SessionStore


@pytest.fixture
def store(tmp_path: Path) -> Iterator[SessionStore]:
    s = SessionStore(tmp_path / "perm.db")
    yield s
    s.close()


def _config(tmp_path: Path, **overrides: object) -> Config:
    project_dir = tmp_path / "proj"
    project_dir.mkdir(exist_ok=True)
    base: dict[str, object] = {
        "projects": [
            {
                "name": "proj",
                "path": str(project_dir),
                "pre_approved_tools": [],
                "pre_denied_tools": [],
            },
        ],
        "ntfy": {"topic": "touchgrass-test"},
        "bearer_token": "a-very-long-bearer-token-please",
        "permission_timeout_seconds": 5,
    }
    base.update(overrides)
    return Config.model_validate(base)


def _project_with_lists(
    tmp_path: Path,
    *,
    pre_approved: list[str] | None = None,
    pre_denied: list[str] | None = None,
) -> Config:
    project_dir = tmp_path / "proj"
    project_dir.mkdir(exist_ok=True)
    return Config.model_validate(
        {
            "projects": [
                {
                    "name": "proj",
                    "path": str(project_dir),
                    "pre_approved_tools": pre_approved or [],
                    "pre_denied_tools": pre_denied or [],
                },
            ],
            "ntfy": {"topic": "touchgrass-test"},
            "bearer_token": "a-very-long-bearer-token-please",
            "permission_timeout_seconds": 5,
        }
    )


async def _create_session_id(store: SessionStore) -> str:
    s = await asyncio.to_thread(store.create_session, "proj")
    return s.id


@pytest.mark.asyncio
async def test_pre_approved_short_circuits_to_allow(
    tmp_path: Path, store: SessionStore
) -> None:
    config = _project_with_lists(tmp_path, pre_approved=["Read"])
    broker = PermissionBroker(config, store)
    queue: asyncio.Queue[Event] = asyncio.Queue()
    session_id = await _create_session_id(store)

    decision = await broker.request(
        session_id=session_id,
        project_name="proj",
        tool_name="Read",
        tool_input={"path": "x"},
        event_queue=queue,
    )
    assert isinstance(decision, PermissionResultAllow)
    # No pending row should have been written.
    assert store.list_pending_permission_requests() == []
    # No event emitted (short-circuit).
    assert queue.empty()


@pytest.mark.asyncio
async def test_pre_denied_short_circuits_to_deny(
    tmp_path: Path, store: SessionStore
) -> None:
    config = _project_with_lists(tmp_path, pre_denied=["Bash"])
    broker = PermissionBroker(config, store)
    queue: asyncio.Queue[Event] = asyncio.Queue()
    session_id = await _create_session_id(store)

    decision = await broker.request(
        session_id=session_id,
        project_name="proj",
        tool_name="Bash",
        tool_input={"cmd": "rm -rf /"},
        event_queue=queue,
    )
    assert isinstance(decision, PermissionResultDeny)
    assert store.list_pending_permission_requests() == []


@pytest.mark.asyncio
async def test_unlisted_tool_blocks_until_resolved_allow_once(
    tmp_path: Path, store: SessionStore
) -> None:
    config = _project_with_lists(tmp_path)
    broker = PermissionBroker(config, store)
    queue: asyncio.Queue[Event] = asyncio.Queue()
    session_id = await _create_session_id(store)

    request_task = asyncio.create_task(
        broker.request(
            session_id=session_id,
            project_name="proj",
            tool_name="Edit",
            tool_input={"path": "x"},
            event_queue=queue,
        )
    )

    # Wait for the broker to emit the permission_request event.
    request_id: str | None = None
    for _ in range(20):
        try:
            event = await asyncio.wait_for(queue.get(), timeout=0.5)
        except TimeoutError:
            break
        if event.type == "permission_request":
            request_id = event.payload["request_id"]
            break
    assert request_id is not None

    # Session status should now be waiting_permission.
    fetched = store.get_session(session_id)
    assert fetched is not None
    assert fetched.status == "waiting_permission"

    await broker.resolve(request_id, "allow_once")
    decision = await asyncio.wait_for(request_task, timeout=2)
    assert isinstance(decision, PermissionResultAllow)

    # allow_once does NOT mutate the project allow list.
    assert "Edit" not in broker.project_allow_list("proj")

    # Session status restored to active.
    fetched = store.get_session(session_id)
    assert fetched is not None
    assert fetched.status == "active"

    # DB row marks the decision.
    pending = store.get_permission_request(request_id)
    assert pending is not None
    assert pending.status == "allowed_once"


@pytest.mark.asyncio
async def test_allow_project_grows_runtime_allow_list(
    tmp_path: Path, store: SessionStore
) -> None:
    config = _project_with_lists(tmp_path)
    broker = PermissionBroker(config, store)
    queue: asyncio.Queue[Event] = asyncio.Queue()
    session_id = await _create_session_id(store)

    task = asyncio.create_task(
        broker.request(
            session_id=session_id,
            project_name="proj",
            tool_name="Bash",
            tool_input={"cmd": "ls"},
            event_queue=queue,
        )
    )

    # Pull events until we see permission_request.
    request_id: str | None = None
    for _ in range(20):
        try:
            event = await asyncio.wait_for(queue.get(), timeout=0.5)
        except TimeoutError:
            break
        if event.type == "permission_request":
            request_id = event.payload["request_id"]
            break
    assert request_id is not None

    await broker.resolve(request_id, "allow_project")
    decision = await asyncio.wait_for(task, timeout=2)
    assert isinstance(decision, PermissionResultAllow)
    assert "Bash" in broker.project_allow_list("proj")

    # A second request for the same tool should now short-circuit.
    queue2: asyncio.Queue[Event] = asyncio.Queue()
    decision2 = await broker.request(
        session_id=session_id,
        project_name="proj",
        tool_name="Bash",
        tool_input={"cmd": "pwd"},
        event_queue=queue2,
    )
    assert isinstance(decision2, PermissionResultAllow)
    assert queue2.empty()


@pytest.mark.asyncio
async def test_deny_decision_returns_deny(
    tmp_path: Path, store: SessionStore
) -> None:
    config = _project_with_lists(tmp_path)
    broker = PermissionBroker(config, store)
    queue: asyncio.Queue[Event] = asyncio.Queue()
    session_id = await _create_session_id(store)

    task = asyncio.create_task(
        broker.request(
            session_id=session_id,
            project_name="proj",
            tool_name="Edit",
            tool_input={},
            event_queue=queue,
        )
    )
    request_id: str | None = None
    for _ in range(20):
        try:
            event = await asyncio.wait_for(queue.get(), timeout=0.5)
        except TimeoutError:
            break
        if event.type == "permission_request":
            request_id = event.payload["request_id"]
            break
    assert request_id is not None

    await broker.resolve(request_id, "deny")
    decision = await asyncio.wait_for(task, timeout=2)
    assert isinstance(decision, PermissionResultDeny)


@pytest.mark.asyncio
async def test_timeout_resolves_to_deny(
    tmp_path: Path, store: SessionStore
) -> None:
    project_dir = tmp_path / "proj"
    project_dir.mkdir(exist_ok=True)
    config = Config.model_validate(
        {
            "projects": [
                {
                    "name": "proj",
                    "path": str(project_dir),
                    "pre_approved_tools": [],
                    "pre_denied_tools": [],
                },
            ],
            "ntfy": {"topic": "t"},
            "bearer_token": "a-very-long-bearer-token-please",
            "permission_timeout_seconds": 1,
        }
    )
    broker = PermissionBroker(config, store)
    queue: asyncio.Queue[Event] = asyncio.Queue()
    session_id = await _create_session_id(store)

    decision = await broker.request(
        session_id=session_id,
        project_name="proj",
        tool_name="Edit",
        tool_input={},
        event_queue=queue,
    )
    assert isinstance(decision, PermissionResultDeny)
    # The DB row should be marked denied.
    pending = store.list_pending_permission_requests()
    assert pending == []  # no longer pending


@pytest.mark.asyncio
async def test_resolve_unknown_id_raises(
    tmp_path: Path, store: SessionStore
) -> None:
    broker = PermissionBroker(_project_with_lists(tmp_path), store)
    with pytest.raises(KeyError, match="no pending"):
        await broker.resolve("nope", "allow_once")


@pytest.mark.asyncio
async def test_ntfy_fires_on_unlisted_request(
    tmp_path: Path, store: SessionStore
) -> None:
    import httpx

    captured: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request.headers.get("title", ""))
        return httpx.Response(200)

    transport = httpx.MockTransport(handler)
    ntfy = NtfyClient("topic", client=httpx.AsyncClient(transport=transport))

    config = _project_with_lists(tmp_path)
    broker = PermissionBroker(config, store, ntfy=ntfy)
    queue: asyncio.Queue[Event] = asyncio.Queue()
    session_id = await _create_session_id(store)

    task = asyncio.create_task(
        broker.request(
            session_id=session_id,
            project_name="proj",
            tool_name="Edit",
            tool_input={"path": "x"},
            event_queue=queue,
        )
    )
    request_id: str | None = None
    for _ in range(20):
        try:
            event = await asyncio.wait_for(queue.get(), timeout=0.5)
        except TimeoutError:
            break
        if event.type == "permission_request":
            request_id = event.payload["request_id"]
            break
    assert request_id is not None

    # Ntfy fires after the event is enqueued.
    for _ in range(20):
        if captured:
            break
        await asyncio.sleep(0.02)
    assert captured == ["Permission needed"]

    await broker.resolve(request_id, "deny")
    await asyncio.wait_for(task, timeout=2)


@pytest.mark.asyncio
async def test_ntfy_not_called_for_pre_approved(
    tmp_path: Path, store: SessionStore
) -> None:
    import httpx

    captured: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.append("called")
        return httpx.Response(200)

    transport = httpx.MockTransport(handler)
    ntfy = NtfyClient("topic", client=httpx.AsyncClient(transport=transport))

    config = _project_with_lists(tmp_path, pre_approved=["Read"])
    broker = PermissionBroker(config, store, ntfy=ntfy)
    queue: asyncio.Queue[Event] = asyncio.Queue()
    session_id = await _create_session_id(store)

    await broker.request(
        session_id=session_id,
        project_name="proj",
        tool_name="Read",
        tool_input={"path": "x"},
        event_queue=queue,
    )
    assert captured == []


@pytest.mark.asyncio
async def test_double_resolve_raises(
    tmp_path: Path, store: SessionStore
) -> None:
    config = _project_with_lists(tmp_path)
    broker = PermissionBroker(config, store)
    queue: asyncio.Queue[Event] = asyncio.Queue()
    session_id = await _create_session_id(store)

    task = asyncio.create_task(
        broker.request(
            session_id=session_id,
            project_name="proj",
            tool_name="Edit",
            tool_input={},
            event_queue=queue,
        )
    )
    request_id: str | None = None
    for _ in range(20):
        try:
            event = await asyncio.wait_for(queue.get(), timeout=0.5)
        except TimeoutError:
            break
        if event.type == "permission_request":
            request_id = event.payload["request_id"]
            break
    assert request_id is not None

    await broker.resolve(request_id, "allow_once")
    await asyncio.wait_for(task, timeout=2)

    with pytest.raises(KeyError, match="no pending"):
        await broker.resolve(request_id, "allow_once")
