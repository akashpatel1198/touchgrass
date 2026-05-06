from __future__ import annotations

import time
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    TextBlock,
)
from fastapi.testclient import TestClient

from touchgrass_daemon.api import create_app
from touchgrass_daemon.config import Config
from touchgrass_daemon.runner import SDKClientLike
from touchgrass_daemon.store import SessionStore

BEARER = "test-bearer-token-of-sufficient-length"
HEADERS = {"Authorization": f"Bearer {BEARER}"}


class _ScriptedClient:
    """Tiny fake SDK client that emits a fixed AssistantMessage per query."""

    instances: list[_ScriptedClient] = []

    def __init__(self, options: ClaudeAgentOptions) -> None:
        self.options = options
        self.queries: list[str] = []
        type(self).instances.append(self)

    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...

    async def query(self, prompt: str) -> None:
        self.queries.append(prompt)

    def receive_response(self) -> AsyncIterator[Any]:
        prompt = self.queries[-1]

        async def gen() -> AsyncIterator[Any]:
            yield AssistantMessage(
                content=[TextBlock(text=f"echo: {prompt}")], model="claude-test"
            )
            yield ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id="fake",
            )

        return gen()


def _factory(options: ClaudeAgentOptions) -> SDKClientLike:
    return _ScriptedClient(options)


@pytest.fixture
def project_dir(tmp_path: Path) -> Path:
    project = tmp_path / "myproj"
    project.mkdir()
    return project


@pytest.fixture
def config(tmp_path: Path, project_dir: Path) -> Config:
    return Config.model_validate(
        {
            "projects": [
                {"name": "myproj", "path": str(project_dir)},
            ],
            "ntfy": {"topic": "touchgrass-test-12345"},
            "bearer_token": BEARER,
        }
    )


@pytest.fixture
def store(tmp_path: Path) -> Iterator[SessionStore]:
    s = SessionStore(tmp_path / "api.db")
    yield s
    s.close()


@pytest.fixture
def client(config: Config, store: SessionStore) -> Iterator[TestClient]:
    _ScriptedClient.instances.clear()
    app = create_app(config, store=store, client_factory=_factory)
    with TestClient(app) as c:
        yield c


def test_health_unauth(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_projects_requires_bearer(client: TestClient) -> None:
    assert client.get("/projects").status_code == 401
    assert client.get("/projects", headers={"Authorization": "Bearer wrong"}).status_code == 401
    response = client.get("/projects", headers=HEADERS)
    assert response.status_code == 200
    state = client.app.state.touchgrass  # type: ignore[attr-defined]
    expected_path = str(state.config.projects[0].path)
    assert response.json() == [{"name": "myproj", "path": expected_path}]


def test_unknown_project_returns_404(client: TestClient) -> None:
    response = client.get("/projects/ghost/sessions", headers=HEADERS)
    assert response.status_code == 404


def test_create_and_list_session(client: TestClient) -> None:
    create = client.post(
        "/projects/myproj/sessions",
        json={"goal": "fix the auth bug"},
        headers=HEADERS,
    )
    assert create.status_code == 201
    session_id = create.json()["session_id"]

    listing = client.get("/projects/myproj/sessions", headers=HEADERS).json()
    assert any(s["id"] == session_id and s["goal"] == "fix the auth bug" for s in listing)

    detail = client.get(f"/sessions/{session_id}", headers=HEADERS).json()
    assert detail["id"] == session_id
    assert detail["status"] == "active"


def test_prompt_persists_assistant_response(client: TestClient) -> None:
    session_id = client.post(
        "/projects/myproj/sessions", json={"goal": None}, headers=HEADERS
    ).json()["session_id"]

    response = client.post(
        f"/sessions/{session_id}/prompts",
        json={"text": "hello"},
        headers=HEADERS,
    )
    assert response.status_code == 202

    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline:
        rows = client.get(
            f"/sessions/{session_id}/messages", headers=HEADERS
        ).json()
        contents = [r["content"] for r in rows]
        if "echo: hello" in contents:
            assert "hello" in contents  # user turn persisted too
            return
        time.sleep(0.05)
    raise AssertionError("assistant echo never landed in messages table")


def test_prompt_unknown_session_404(client: TestClient) -> None:
    response = client.post(
        "/sessions/nope/prompts", json={"text": "hi"}, headers=HEADERS
    )
    assert response.status_code == 404


def test_messages_pagination(client: TestClient) -> None:
    session_id = client.post(
        "/projects/myproj/sessions", json={}, headers=HEADERS
    ).json()["session_id"]
    for word in ["one", "two", "three"]:
        client.post(
            f"/sessions/{session_id}/prompts", json={"text": word}, headers=HEADERS
        )
        # Wait until that round trip is durable before sending the next.
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            rows = client.get(
                f"/sessions/{session_id}/messages", headers=HEADERS
            ).json()
            if any(r["content"] == f"echo: {word}" for r in rows):
                break
            time.sleep(0.02)
        else:
            raise AssertionError(f"never saw echo for {word}")

    last_two = client.get(
        f"/sessions/{session_id}/messages?limit=2", headers=HEADERS
    ).json()
    assert len(last_two) == 2


def test_websocket_streams_events_and_accepts_inline_prompts(client: TestClient) -> None:
    session_id = client.post(
        "/projects/myproj/sessions", json={"goal": "ws-test"}, headers=HEADERS
    ).json()["session_id"]

    with client.websocket_connect(
        f"/sessions/{session_id}/stream", headers=HEADERS
    ) as ws:
        ws.send_json({"type": "prompt", "text": "ping"})
        seen = []
        for _ in range(20):
            msg = ws.receive_json()
            seen.append(msg)
            if (
                msg.get("type") == "assistant_message"
                and msg.get("payload", {}).get("text") == "echo: ping"
            ):
                return
        raise AssertionError(f"never saw echoed assistant_message; saw {seen}")


def test_websocket_unauth_closes(client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    session_id = client.post(
        "/projects/myproj/sessions", json={}, headers=HEADERS
    ).json()["session_id"]

    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect(f"/sessions/{session_id}/stream") as ws,
    ):
        ws.receive_json()


def test_websocket_unknown_session_closes(client: TestClient) -> None:
    from starlette.websockets import WebSocketDisconnect

    with (
        pytest.raises(WebSocketDisconnect),
        client.websocket_connect(
            "/sessions/nope/stream", headers=HEADERS
        ) as ws,
    ):
        ws.receive_json()


def test_pending_permissions_lists_db_rows(client: TestClient) -> None:
    state = client.app.state.touchgrass  # type: ignore[attr-defined]
    session = state.store.create_session("myproj")
    state.store.create_permission_request(session.id, "Bash", '{"cmd":"ls"}')

    response = client.get("/permissions/pending", headers=HEADERS)
    assert response.status_code == 200
    rows = response.json()
    assert len(rows) == 1
    assert rows[0]["tool_name"] == "Bash"
    assert rows[0]["status"] == "pending"


def test_decision_unknown_id_returns_404(client: TestClient) -> None:
    response = client.post(
        "/permissions/nonexistent/decision",
        json={"decision": "allow_once"},
        headers=HEADERS,
    )
    assert response.status_code == 404


def test_decision_invalid_kind_returns_422(client: TestClient) -> None:
    response = client.post(
        "/permissions/anything/decision",
        json={"decision": "made_up_value"},
        headers=HEADERS,
    )
    assert response.status_code == 422


def test_permissions_endpoints_require_bearer(client: TestClient) -> None:
    assert client.get("/permissions/pending").status_code == 401
    assert (
        client.post(
            "/permissions/whatever/decision", json={"decision": "deny"}
        ).status_code
        == 401
    )
