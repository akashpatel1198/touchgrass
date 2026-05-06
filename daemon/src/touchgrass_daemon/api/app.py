"""FastAPI app factory.

Wires routes, owns app state, and handles graceful shutdown — on SIGTERM/SIGINT,
all active sessions are marked `failed` (resumable sessions land in a later phase).
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from ..config import Config
from ..runner import SDKClientFactory, _default_client_factory
from ..store import SessionStore
from .routes import health, permissions, projects, sessions, streams
from .state import AppState

log = logging.getLogger(__name__)


def create_app(
    config: Config,
    *,
    store: SessionStore | None = None,
    client_factory: SDKClientFactory = _default_client_factory,
) -> FastAPI:
    """Construct the FastAPI app. `store` and `client_factory` are injectable for tests."""
    state = AppState(
        config=config,
        store=store or SessionStore(),
        client_factory=client_factory,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            await state.shutdown()

    app = FastAPI(title="touchgrass-daemon", lifespan=lifespan)
    app.state.touchgrass = state
    app.state.config = config  # auth dependency reads from here

    app.include_router(health.router)
    app.include_router(projects.router)
    app.include_router(sessions.router)
    app.include_router(streams.router)
    app.include_router(permissions.router)
    return app
