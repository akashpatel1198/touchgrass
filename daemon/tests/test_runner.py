from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    PermissionResultAllow,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from touchgrass_daemon.config import ProjectConfig
from touchgrass_daemon.events import Event
from touchgrass_daemon.runner import SDKClientLike, SessionRunner
from touchgrass_daemon.store import SessionStore


class FakeSDKClient:
    """In-memory fake of `ClaudeSDKClient` for tests.

    Each call to `query()` is paired with a scripted message stream provided up front.
    """

    def __init__(self, scripts: list[list[Any]]) -> None:
        self._scripts = list(scripts)
        self.queries: list[str] = []
        self.connected = False
        self.disconnected = False
        self.options: ClaudeAgentOptions | None = None

    @classmethod
    def factory(cls, scripts: list[list[Any]]) -> tuple[Any, FakeSDKClient]:
        instance = cls(scripts)

        def make(options: ClaudeAgentOptions) -> SDKClientLike:
            instance.options = options
            return instance

        return make, instance

    async def connect(self) -> None:
        self.connected = True

    async def disconnect(self) -> None:
        self.disconnected = True

    async def query(self, prompt: str) -> None:
        self.queries.append(prompt)

    def receive_response(self) -> AsyncIterator[Any]:
        if not self._scripts:
            raise AssertionError("FakeSDKClient ran out of scripted responses")
        script = self._scripts.pop(0)

        async def gen() -> AsyncIterator[Any]:
            for item in script:
                yield item

        return gen()


@pytest.fixture
def store(tmp_path: Path) -> Iterator[SessionStore]:
    s = SessionStore(tmp_path / "runner.db")
    yield s
    s.close()


@pytest.fixture
def project(tmp_path: Path) -> ProjectConfig:
    project_dir = tmp_path / "proj"
    project_dir.mkdir()
    return ProjectConfig(name="proj", path=project_dir)


def _result_message() -> ResultMessage:
    return ResultMessage(
        subtype="success",
        duration_ms=10,
        duration_api_ms=5,
        is_error=False,
        num_turns=1,
        session_id="fake",
    )


@pytest.mark.asyncio
async def test_assistant_text_persists_and_emits_event(
    store: SessionStore, project: ProjectConfig
) -> None:
    factory, fake = FakeSDKClient.factory(
        [
            [
                AssistantMessage(content=[TextBlock(text="hi there")], model="claude-test"),
                _result_message(),
            ]
        ]
    )
    queue: asyncio.Queue[Event] = asyncio.Queue()
    session = store.create_session(project.name)
    runner = SessionRunner(
        project=project,
        session_id=session.id,
        store=store,
        event_queue=queue,
        client_factory=factory,
    )
    await runner.start()
    run_task = asyncio.create_task(runner.run())
    await runner.submit_prompt("hello")

    # Drain expected events: session_status active, then assistant_message.
    events = await _collect_until(queue, predicate=lambda e: e.type == "assistant_message")
    await runner.stop()
    await asyncio.wait_for(run_task, timeout=2)

    assert fake.connected and fake.disconnected
    assert fake.queries == ["hello"]
    assert any(e.type == "session_status" and e.payload["status"] == "active" for e in events)
    assistant = next(e for e in events if e.type == "assistant_message")
    assert assistant.payload == {"text": "hi there"}

    rows = store.get_messages(session.id)
    assert [(m.role, m.content) for m in rows] == [
        ("user", "hello"),
        ("assistant", "hi there"),
    ]


@pytest.mark.asyncio
async def test_tool_call_and_result_persist(
    store: SessionStore, project: ProjectConfig
) -> None:
    factory, _fake = FakeSDKClient.factory(
        [
            [
                AssistantMessage(
                    content=[ToolUseBlock(id="t1", name="Read", input={"path": "x.py"})],
                    model="claude-test",
                ),
                UserMessage(
                    content=[
                        ToolResultBlock(tool_use_id="t1", content="file contents")
                    ]
                ),
                AssistantMessage(content=[TextBlock(text="done")], model="claude-test"),
                _result_message(),
            ]
        ]
    )
    queue: asyncio.Queue[Event] = asyncio.Queue()
    session = store.create_session(project.name)
    runner = SessionRunner(
        project=project,
        session_id=session.id,
        store=store,
        event_queue=queue,
        client_factory=factory,
    )
    await runner.start()
    run_task = asyncio.create_task(runner.run())
    await runner.submit_prompt("read x.py")

    events = await _collect_until(
        queue,
        predicate=lambda e: e.type == "assistant_message" and e.payload["text"] == "done",
    )
    await runner.stop()
    await asyncio.wait_for(run_task, timeout=2)

    types = [e.type for e in events]
    assert "tool_call" in types
    assert "tool_result" in types
    tool_call = next(e for e in events if e.type == "tool_call")
    assert tool_call.payload["tool_name"] == "Read"
    assert tool_call.payload["tool_args"] == {"path": "x.py"}

    rows = [(m.role, m.tool_name, m.content) for m in store.get_messages(session.id)]
    assert ("tool_call", "Read", '{"path": "x.py"}') in rows
    assert ("tool_result", None, "file contents") in rows


@pytest.mark.asyncio
async def test_can_use_tool_phase1_allows(
    store: SessionStore, project: ProjectConfig
) -> None:
    factory, fake = FakeSDKClient.factory([[_result_message()]])
    queue: asyncio.Queue[Event] = asyncio.Queue()
    session = store.create_session(project.name)
    runner = SessionRunner(
        project=project,
        session_id=session.id,
        store=store,
        event_queue=queue,
        client_factory=factory,
    )
    await runner.start()

    callback = fake.options.can_use_tool  # type: ignore[union-attr]
    assert callback is not None
    decision = await callback("Bash", {"cmd": "ls"}, None)  # type: ignore[arg-type]
    assert isinstance(decision, PermissionResultAllow)

    await runner.stop()


@pytest.mark.asyncio
async def test_run_must_be_started_first(
    store: SessionStore, project: ProjectConfig
) -> None:
    factory, _fake = FakeSDKClient.factory([])
    queue: asyncio.Queue[Event] = asyncio.Queue()
    session = store.create_session(project.name)
    runner = SessionRunner(
        project=project,
        session_id=session.id,
        store=store,
        event_queue=queue,
        client_factory=factory,
    )
    with pytest.raises(RuntimeError, match="start"):
        await runner.run()


@pytest.mark.asyncio
async def test_options_use_project_cwd(
    store: SessionStore, project: ProjectConfig
) -> None:
    factory, fake = FakeSDKClient.factory([])
    queue: asyncio.Queue[Event] = asyncio.Queue()
    session = store.create_session(project.name)
    runner = SessionRunner(
        project=project,
        session_id=session.id,
        store=store,
        event_queue=queue,
        client_factory=factory,
    )
    await runner.start()
    assert fake.options is not None
    assert Path(str(fake.options.cwd)) == project.path
    await runner.stop()


async def _collect_until(
    queue: asyncio.Queue[Event],
    *,
    predicate: Any,
    timeout: float = 2.0,
) -> list[Event]:
    """Pull events off the queue until `predicate(event)` is true. Includes that event."""
    out: list[Event] = []
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            raise TimeoutError(f"event predicate not satisfied within {timeout}s; got {out}")
        event = await asyncio.wait_for(queue.get(), timeout=remaining)
        out.append(event)
        if predicate(event):
            return out
