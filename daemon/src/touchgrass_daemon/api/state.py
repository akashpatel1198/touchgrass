"""Shared app state: config, store, hub registry, and the SDK client factory."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

from ..config import Config, ProjectConfig
from ..events import Event
from ..runner import SDKClientFactory, SessionRunner, _default_client_factory
from ..store import SessionStore
from .hub import SessionHub

log = logging.getLogger(__name__)


@dataclass
class AppState:
    config: Config
    store: SessionStore
    client_factory: SDKClientFactory = field(default=_default_client_factory)
    hubs: dict[str, SessionHub] = field(default_factory=dict)
    _hubs_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def project(self, name: str) -> ProjectConfig | None:
        return next((p for p in self.config.projects if p.name == name), None)

    async def start_session(
        self, project: ProjectConfig, goal: str | None = None
    ) -> SessionHub:
        session = await asyncio.to_thread(
            self.store.create_session, project.name, goal
        )
        queue: asyncio.Queue[Event] = asyncio.Queue()
        runner = SessionRunner(
            project=project,
            session_id=session.id,
            store=self.store,
            event_queue=queue,
            client_factory=self.client_factory,
        )
        hub = SessionHub(runner, queue)
        await hub.start()
        async with self._hubs_lock:
            self.hubs[session.id] = hub
        return hub

    def get_hub(self, session_id: str) -> SessionHub | None:
        return self.hubs.get(session_id)

    async def shutdown(self) -> None:
        async with self._hubs_lock:
            hubs = list(self.hubs.values())
            self.hubs.clear()
        for hub in hubs:
            try:
                await hub.stop()
            except Exception:
                log.exception("error stopping hub %s during shutdown", hub.session_id)
            try:
                await asyncio.to_thread(
                    self.store.update_session_status, hub.session_id, "failed"
                )
            except Exception:
                log.exception("error marking session %s failed", hub.session_id)
        self.store.close()
