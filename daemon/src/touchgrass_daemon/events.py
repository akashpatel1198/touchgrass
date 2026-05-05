"""Event types streamed from a `SessionRunner` to API subscribers.

The same shape goes onto an `asyncio.Queue` for in-process fan-out and gets
serialized over the WebSocket. Keep payloads JSON-serializable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

EventType = Literal[
    "assistant_message",   # complete assistant turn (full text)
    "tool_call",           # tool invocation requested by the assistant
    "tool_result",         # tool result fed back to the assistant
    "permission_request",  # broker is waiting on a decision (phase 2)
    "session_status",      # status transition (active/waiting_permission/completed/failed)
    "error",               # SDK or runner-level failure
]


@dataclass(frozen=True, slots=True)
class Event:
    type: EventType
    session_id: str
    payload: dict[str, Any] = field(default_factory=dict)
