from __future__ import annotations

import asyncio
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from ...permissions import DecisionKind
from ...store import PermissionRequest as PermissionRow
from ..auth import require_bearer
from ..state import AppState

router = APIRouter(dependencies=[Depends(require_bearer)])


class PermissionRequestOut(BaseModel):
    id: str
    session_id: str
    tool_name: str
    tool_args: str
    status: str
    created_at: str
    resolved_at: str | None

    @classmethod
    def from_row(cls, row: PermissionRow) -> PermissionRequestOut:
        return cls(
            id=row.id,
            session_id=row.session_id,
            tool_name=row.tool_name,
            tool_args=row.tool_args,
            status=row.status,
            created_at=row.created_at.isoformat(),
            resolved_at=row.resolved_at.isoformat() if row.resolved_at else None,
        )


class DecisionIn(BaseModel):
    decision: DecisionKind


def _state(request: Request) -> AppState:
    return cast(AppState, request.app.state.touchgrass)


@router.get("/permissions/pending", response_model=list[PermissionRequestOut])
async def list_pending(request: Request) -> list[PermissionRequestOut]:
    state = _state(request)
    rows = await asyncio.to_thread(state.store.list_pending_permission_requests)
    return [PermissionRequestOut.from_row(r) for r in rows]


@router.post(
    "/permissions/{request_id}/decision",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def submit_decision(
    request_id: str, body: DecisionIn, request: Request
) -> None:
    state = _state(request)
    try:
        await state.broker.resolve(request_id, body.decision)
    except KeyError as exc:
        # KeyError from the broker means either "not found" or "already resolved";
        # the message text disambiguates. We collapse both into 409 since the
        # client's correct response is the same: stop trying.
        msg = str(exc).strip("'")
        if "no pending" in msg:
            raise HTTPException(status.HTTP_404_NOT_FOUND, msg) from exc
        raise HTTPException(status.HTTP_409_CONFLICT, msg) from exc
