"""Per-session runner around a Claude Agent SDK client.

Each `SessionRunner` owns one SDK conversation, scoped to one project's working
directory. Prompts submitted from the API land on an internal queue and are driven
through the SDK serially. Every assistant turn, tool call, and tool result is
persisted to the `SessionStore` AND fanned out as an `Event` for live subscribers.

The SDK client is constructed via an injectable factory so tests can pass a fake.
Per CLAUDE.md, tests must not make real SDK calls.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any, Protocol

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKClient,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ThinkingBlock,
    ToolPermissionContext,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
)

from .config import ProjectConfig
from .events import Event
from .store import SessionStore

log = logging.getLogger(__name__)


class SDKClientLike(Protocol):
    """Minimum surface of `ClaudeSDKClient` we depend on. Lets tests substitute a fake."""

    async def connect(self) -> None: ...
    async def disconnect(self) -> None: ...
    async def query(self, prompt: str) -> None: ...
    def receive_response(self) -> AsyncIterator[Any]: ...


SDKClientFactory = Callable[[ClaudeAgentOptions], SDKClientLike]


def _default_client_factory(options: ClaudeAgentOptions) -> SDKClientLike:
    return ClaudeSDKClient(options=options)


@dataclass
class _Prompt:
    text: str
    done: asyncio.Event


class SessionRunner:
    """Drives a single SDK session for one project.

    Lifecycle:
      runner = SessionRunner(...)
      await runner.start()             # connects the SDK client
      task = asyncio.create_task(runner.run())  # main loop
      await runner.submit_prompt("hi") # any number of times
      await runner.stop()              # disconnects, cancels run()
    """

    def __init__(
        self,
        *,
        project: ProjectConfig,
        session_id: str,
        store: SessionStore,
        event_queue: asyncio.Queue[Event],
        client_factory: SDKClientFactory = _default_client_factory,
    ) -> None:
        self._project = project
        self._session_id = session_id
        self._store = store
        self._events = event_queue
        self._client_factory = client_factory
        self._prompt_queue: asyncio.Queue[_Prompt] = asyncio.Queue()
        self._client: SDKClientLike | None = None
        self._stop_requested = asyncio.Event()

    @property
    def session_id(self) -> str:
        return self._session_id

    async def start(self) -> None:
        if self._client is not None:
            return
        options = ClaudeAgentOptions(
            cwd=self._project.path,
            can_use_tool=self._can_use_tool,
        )
        self._client = self._client_factory(options)
        await self._client.connect()
        await self._emit_status("active")

    async def stop(self) -> None:
        self._stop_requested.set()
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:
                log.exception("error disconnecting SDK client for session %s", self._session_id)
            self._client = None

    async def submit_prompt(self, text: str) -> None:
        """Enqueue a user turn. Returns immediately — the run loop processes it."""
        await self._store_message_threadsafe("user", text)
        await self._prompt_queue.put(_Prompt(text=text, done=asyncio.Event()))

    async def run(self) -> None:
        """Main loop. Pulls prompts off the queue and drives the SDK serially."""
        if self._client is None:
            raise RuntimeError("SessionRunner.start() must be called before run()")
        try:
            while not self._stop_requested.is_set():
                prompt = await self._next_prompt_or_stop()
                if prompt is None:
                    return
                await self._drive_turn(prompt.text)
                prompt.done.set()
            await self._emit_status("completed")
            await self._update_status_threadsafe("completed")
        except Exception as exc:
            log.exception("session %s failed in run loop", self._session_id)
            await self._emit_event(
                Event("error", self._session_id, {"message": str(exc)})
            )
            await self._update_status_threadsafe("failed")
            await self._emit_status("failed")
            raise

    # --- Internals -------------------------------------------------------------

    async def _next_prompt_or_stop(self) -> _Prompt | None:
        get_task = asyncio.create_task(self._prompt_queue.get())
        stop_task = asyncio.create_task(self._stop_requested.wait())
        try:
            done, _pending = await asyncio.wait(
                [get_task, stop_task], return_when=asyncio.FIRST_COMPLETED
            )
            if get_task in done:
                stop_task.cancel()
                return get_task.result()
            get_task.cancel()
            return None
        finally:
            for task in (get_task, stop_task):
                if not task.done():
                    task.cancel()

    async def _drive_turn(self, prompt: str) -> None:
        assert self._client is not None
        await self._client.query(prompt)
        async for message in self._client.receive_response():
            await self._handle_message(message)

    async def _handle_message(self, message: Any) -> None:
        if isinstance(message, AssistantMessage):
            for block in message.content:
                await self._handle_assistant_block(block)
        elif isinstance(message, UserMessage):
            # User messages from the SDK loop are tool results coming back from the harness.
            if isinstance(message.content, list):
                for block in message.content:
                    if isinstance(block, ToolResultBlock):
                        await self._handle_tool_result(block)
        elif isinstance(message, ResultMessage):
            # End of turn — nothing to do; the loop will pick up the next prompt.
            return
        elif isinstance(message, SystemMessage):
            # SDK init / heartbeat noise. Ignore for now; could surface in phase 2.
            return

    async def _handle_assistant_block(self, block: Any) -> None:
        if isinstance(block, TextBlock):
            await self._store_message_threadsafe("assistant", block.text)
            await self._emit_event(
                Event("assistant_message", self._session_id, {"text": block.text})
            )
        elif isinstance(block, ToolUseBlock):
            args_json = json.dumps(block.input, default=str)
            await self._store_message_threadsafe(
                "tool_call",
                args_json,
                tool_name=block.name,
                tool_args=args_json,
            )
            await self._emit_event(
                Event(
                    "tool_call",
                    self._session_id,
                    {
                        "tool_use_id": block.id,
                        "tool_name": block.name,
                        "tool_args": block.input,
                    },
                )
            )
        elif isinstance(block, ThinkingBlock):
            # Don't persist thinking content — too noisy and not useful in transcripts.
            return

    async def _handle_tool_result(self, block: ToolResultBlock) -> None:
        if isinstance(block.content, list):
            content_text = json.dumps(block.content, default=str)
        else:
            content_text = block.content or ""
        await self._store_message_threadsafe("tool_result", content_text)
        await self._emit_event(
            Event(
                "tool_result",
                self._session_id,
                {
                    "tool_use_id": block.tool_use_id,
                    "content": block.content,
                    "is_error": bool(block.is_error),
                },
            )
        )

    async def _can_use_tool(
        self,
        tool_name: str,
        tool_input: dict[str, Any],
        context: ToolPermissionContext,
    ) -> PermissionResultAllow | PermissionResultDeny:
        # Phase 1: blanket-allow. The real broker (allow once / for project / deny + ntfy)
        # lands in phase 2. The signature is in place now so the wiring doesn't change.
        del tool_input, context  # unused in phase 1
        log.debug("phase-1 auto-allow for tool %s on session %s", tool_name, self._session_id)
        return PermissionResultAllow()

    async def _emit_event(self, event: Event) -> None:
        await self._events.put(event)

    async def _emit_status(self, status: str) -> None:
        await self._emit_event(
            Event("session_status", self._session_id, {"status": status})
        )

    async def _store_message_threadsafe(
        self,
        role: str,
        content: str,
        *,
        tool_name: str | None = None,
        tool_args: str | None = None,
    ) -> None:
        # SessionStore is sync; offload to a thread so we don't block the event loop.
        await asyncio.to_thread(
            self._store.append_message,
            self._session_id,
            role,  # type: ignore[arg-type]
            content,
            tool_name=tool_name,
            tool_args=tool_args,
        )

    async def _update_status_threadsafe(self, status: str) -> None:
        await asyncio.to_thread(
            self._store.update_session_status,
            self._session_id,
            status,  # type: ignore[arg-type]
        )
