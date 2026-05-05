"""Dataclass return types for the session store. Mirrors the SQL schema 1:1."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Literal

SessionStatus = Literal["active", "waiting_permission", "completed", "failed"]
MessageRole = Literal["user", "assistant", "tool_call", "tool_result"]
PermissionStatus = Literal[
    "pending", "allowed_once", "allowed_project", "denied"
]


@dataclass(frozen=True, slots=True)
class Session:
    id: str
    project_name: str
    goal: str | None
    status: SessionStatus
    created_at: datetime


@dataclass(frozen=True, slots=True)
class Message:
    id: int
    session_id: str
    role: MessageRole
    content: str
    tool_name: str | None
    tool_args: str | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class PermissionRequest:
    id: str
    session_id: str
    tool_name: str
    tool_args: str
    status: PermissionStatus
    created_at: datetime
    resolved_at: datetime | None
