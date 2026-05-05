"""Per-session hub: owns the runner, fans events out to subscribers, exposes prompt entry.

One hub per active session. The runner emits to a private internal queue; the hub's
fan-out task copies each event onto every live subscriber's queue. Subscribers come
and go (WebSocket connections); the hub outlives them.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from ..events import Event
from ..runner import SessionRunner

log = logging.getLogger(__name__)

_SUBSCRIBER_QUEUE_MAX = 256


class SessionHub:
    def __init__(self, runner: SessionRunner, internal_queue: asyncio.Queue[Event]) -> None:
        self._runner = runner
        self._internal_queue = internal_queue
        self._subscribers: list[asyncio.Queue[Event]] = []
        self._subscribers_lock = asyncio.Lock()
        self._run_task: asyncio.Task[None] | None = None
        self._fanout_task: asyncio.Task[None] | None = None

    @property
    def session_id(self) -> str:
        return self._runner.session_id

    async def start(self) -> None:
        await self._runner.start()
        self._run_task = asyncio.create_task(
            self._runner.run(), name=f"runner-{self.session_id}"
        )
        self._fanout_task = asyncio.create_task(
            self._fanout(), name=f"fanout-{self.session_id}"
        )

    async def submit_prompt(self, text: str) -> None:
        await self._runner.submit_prompt(text)

    async def stop(self) -> None:
        await self._runner.stop()
        if self._run_task is not None:
            try:
                await asyncio.wait_for(self._run_task, timeout=5)
            except (TimeoutError, asyncio.CancelledError, Exception):
                self._run_task.cancel()
        if self._fanout_task is not None:
            self._fanout_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._fanout_task

    @asynccontextmanager
    async def subscribe(self) -> AsyncIterator[asyncio.Queue[Event]]:
        queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=_SUBSCRIBER_QUEUE_MAX)
        async with self._subscribers_lock:
            self._subscribers.append(queue)
        try:
            yield queue
        finally:
            async with self._subscribers_lock:
                if queue in self._subscribers:
                    self._subscribers.remove(queue)

    async def _fanout(self) -> None:
        while True:
            event = await self._internal_queue.get()
            async with self._subscribers_lock:
                subscribers = list(self._subscribers)
            for sub in subscribers:
                try:
                    sub.put_nowait(event)
                except asyncio.QueueFull:
                    # A slow subscriber shouldn't stall the runner. Drop the oldest.
                    log.warning(
                        "subscriber queue full on session %s — dropping oldest event",
                        self.session_id,
                    )
                    try:
                        sub.get_nowait()
                        sub.put_nowait(event)
                    except (asyncio.QueueEmpty, asyncio.QueueFull):
                        pass
