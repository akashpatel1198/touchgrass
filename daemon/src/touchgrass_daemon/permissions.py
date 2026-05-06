"""Permission decision broker.

Owns per-project allow/deny lists (seeded from config, mutated at runtime by
'Allow for project' decisions) and a pending-request registry. The SDK's
`canUseTool` callback delegates to `request()`, which either short-circuits
on a pre-listed tool or blocks on an `asyncio.Future` until a phone decision
arrives via `POST /permissions/{request_id}/decision`. Timeouts default to deny.

The in-memory `_pending` registry is the source of truth for "can this future
be resolved?" The SQLite `permission_requests` table is the source of truth for
"what happened?" — every decision lands there with a final status.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from dataclasses import dataclass
from typing import Any, Literal

from claude_agent_sdk import PermissionResultAllow, PermissionResultDeny

from .config import Config
from .events import Event
from .store import PermissionStatus, SessionStore

log = logging.getLogger(__name__)

DecisionKind = Literal["allow_once", "allow_project", "deny"]
SDKDecision = PermissionResultAllow | PermissionResultDeny

_DECISION_TO_STATUS: dict[DecisionKind, PermissionStatus] = {
    "allow_once": "allowed_once",
    "allow_project": "allowed_project",
    "deny": "denied",
}


@dataclass
class _PendingEntry:
    request_id: str
    session_id: str
    project_name: str
    tool_name: str
    future: asyncio.Future[SDKDecision]
    event_queue: asyncio.Queue[Event]


class PermissionBroker:
    def __init__(self, config: Config, store: SessionStore) -> None:
        self._config = config
        self._store = store
        self._allow: dict[str, set[str]] = {
            p.name: set(p.pre_approved_tools) for p in config.projects
        }
        self._deny: dict[str, set[str]] = {
            p.name: set(p.pre_denied_tools) for p in config.projects
        }
        self._pending: dict[str, _PendingEntry] = {}
        self._lock = asyncio.Lock()

    def is_pre_approved(self, project_name: str, tool_name: str) -> bool:
        return tool_name in self._allow.get(project_name, set())

    def is_pre_denied(self, project_name: str, tool_name: str) -> bool:
        return tool_name in self._deny.get(project_name, set())

    async def request(
        self,
        *,
        session_id: str,
        project_name: str,
        tool_name: str,
        tool_input: dict[str, Any],
        event_queue: asyncio.Queue[Event],
    ) -> SDKDecision:
        """Decide whether `tool_name` can run.

        Pre-denied → immediate deny. Pre-approved → immediate allow. Otherwise
        we persist a pending row, emit a `permission_request` event, and block
        until either a REST decision lands or `permission_timeout_seconds`
        elapses (in which case we default to deny).
        """
        if self.is_pre_denied(project_name, tool_name):
            log.debug("pre-denied %s on %s", tool_name, project_name)
            return PermissionResultDeny(message="tool denied by config")
        if self.is_pre_approved(project_name, tool_name):
            log.debug("pre-approved %s on %s", tool_name, project_name)
            return PermissionResultAllow()

        return await self._await_decision(
            session_id=session_id,
            project_name=project_name,
            tool_name=tool_name,
            tool_input=tool_input,
            event_queue=event_queue,
        )

    async def resolve(self, request_id: str, kind: DecisionKind) -> None:
        """Apply a decision from the REST endpoint.

        Raises `KeyError` if there's no pending request with that id (404 in
        the route) or if it's already been resolved (409 in the route).
        """
        async with self._lock:
            entry = self._pending.get(request_id)
            if entry is None:
                raise KeyError(f"no pending permission request: {request_id}")
            if entry.future.done():
                raise KeyError(f"permission request already resolved: {request_id}")

        await asyncio.to_thread(
            self._store.resolve_permission_request,
            request_id,
            _DECISION_TO_STATUS[kind],
        )

        if kind == "allow_project":
            self._allow.setdefault(entry.project_name, set()).add(entry.tool_name)

        if kind == "deny":
            entry.future.set_result(
                PermissionResultDeny(message="denied by user")
            )
        else:
            entry.future.set_result(PermissionResultAllow())

    def project_allow_list(self, project_name: str) -> set[str]:
        """Snapshot of currently-allowed tool names for a project."""
        return set(self._allow.get(project_name, set()))

    # --- Internals -------------------------------------------------------------

    async def _await_decision(
        self,
        *,
        session_id: str,
        project_name: str,
        tool_name: str,
        tool_input: dict[str, Any],
        event_queue: asyncio.Queue[Event],
    ) -> SDKDecision:
        args_json = json.dumps(tool_input, default=str)
        request = await asyncio.to_thread(
            self._store.create_permission_request,
            session_id,
            tool_name,
            args_json,
        )
        future: asyncio.Future[SDKDecision] = (
            asyncio.get_running_loop().create_future()
        )
        entry = _PendingEntry(
            request_id=request.id,
            session_id=session_id,
            project_name=project_name,
            tool_name=tool_name,
            future=future,
            event_queue=event_queue,
        )
        async with self._lock:
            self._pending[request.id] = entry

        await self._update_status(session_id, "waiting_permission", event_queue)
        await event_queue.put(
            Event(
                "permission_request",
                session_id,
                {
                    "request_id": request.id,
                    "tool_name": tool_name,
                    "tool_args": tool_input,
                    "created_at": request.created_at.isoformat(),
                },
            )
        )

        try:
            decision = await asyncio.wait_for(
                future, timeout=self._config.permission_timeout_seconds
            )
            return decision
        except TimeoutError:
            log.warning(
                "permission request %s timed out after %ss; defaulting to deny",
                request.id,
                self._config.permission_timeout_seconds,
            )
            with contextlib.suppress(KeyError):
                await asyncio.to_thread(
                    self._store.resolve_permission_request, request.id, "denied"
                )
            return PermissionResultDeny(
                message="permission request timed out"
            )
        finally:
            async with self._lock:
                self._pending.pop(request.id, None)
            with contextlib.suppress(Exception):
                await self._update_status(session_id, "active", event_queue)

    async def _update_status(
        self,
        session_id: str,
        status: Literal["active", "waiting_permission"],
        event_queue: asyncio.Queue[Event],
    ) -> None:
        await asyncio.to_thread(
            self._store.update_session_status, session_id, status
        )
        await event_queue.put(
            Event("session_status", session_id, {"status": status})
        )
