"""WebSocket endpoint that streams a single session's events to subscribers.

Connection lifecycle:
  1. Bearer-auth on connect; close 4401 if missing/wrong.
  2. Replay the last `replay_limit` messages from SQLite as `replay` events.
  3. Forward live events from the session hub.
  4. Concurrently accept inbound `{"type":"prompt","text":"..."}` frames as user turns.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict
from typing import Any, cast

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from ...events import Event
from ..auth import authorize_websocket
from ..state import AppState

router = APIRouter()
log = logging.getLogger(__name__)

DEFAULT_REPLAY_LIMIT = 50


def _state(websocket: WebSocket) -> AppState:
    return cast(AppState, websocket.app.state.touchgrass)


def _event_to_payload(event: Event) -> dict[str, Any]:
    return asdict(event)


@router.websocket("/sessions/{session_id}/stream")
async def session_stream(
    websocket: WebSocket,
    session_id: str,
    replay_limit: int = Query(default=DEFAULT_REPLAY_LIMIT, ge=0, le=500),
) -> None:
    if not await authorize_websocket(websocket):
        return

    state = _state(websocket)
    hub = state.get_hub(session_id)
    if hub is None:
        await websocket.close(code=4404, reason="session not active on this daemon")
        return

    await websocket.accept()

    # Replay recent history so the client paints immediately on reconnect.
    try:
        rows = await asyncio.to_thread(
            state.store.get_messages, session_id, limit=replay_limit
        )
    except Exception:
        log.exception("failed to replay messages for session %s", session_id)
        rows = []
    for row in rows:
        await websocket.send_json(
            {
                "type": "replay",
                "session_id": session_id,
                "payload": {
                    "id": row.id,
                    "role": row.role,
                    "content": row.content,
                    "tool_name": row.tool_name,
                    "tool_args": row.tool_args,
                    "created_at": row.created_at.isoformat(),
                },
            }
        )

    async with hub.subscribe() as subscriber:
        receive_task = asyncio.create_task(
            _receive_loop(websocket, hub), name=f"ws-recv-{session_id}"
        )
        send_task = asyncio.create_task(
            _send_loop(websocket, subscriber), name=f"ws-send-{session_id}"
        )
        try:
            done, pending = await asyncio.wait(
                {receive_task, send_task}, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            for task in done:
                exc = task.exception()
                if exc and not isinstance(exc, WebSocketDisconnect):
                    log.warning("ws task ended with %s", exc)
        finally:
            for task in (receive_task, send_task):
                if not task.done():
                    task.cancel()


async def _send_loop(websocket: WebSocket, subscriber: asyncio.Queue[Event]) -> None:
    while True:
        event = await subscriber.get()
        await websocket.send_json(_event_to_payload(event))


async def _receive_loop(websocket: WebSocket, hub: Any) -> None:
    while True:
        message = await websocket.receive_json()
        if not isinstance(message, dict):
            continue
        if message.get("type") == "prompt":
            text = message.get("text")
            if isinstance(text, str) and text.strip():
                await hub.submit_prompt(text)
