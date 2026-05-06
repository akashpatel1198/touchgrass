from __future__ import annotations

import asyncio
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field

from ...changelog import write_changelog
from ...store import Message as MessageRow
from ..auth import require_bearer
from ..state import AppState
from .projects import SessionOut

router = APIRouter(dependencies=[Depends(require_bearer)])


class MessageOut(BaseModel):
    id: int
    session_id: str
    role: str
    content: str
    tool_name: str | None
    tool_args: str | None
    created_at: str

    @classmethod
    def from_row(cls, row: MessageRow) -> MessageOut:
        return cls(
            id=row.id,
            session_id=row.session_id,
            role=row.role,
            content=row.content,
            tool_name=row.tool_name,
            tool_args=row.tool_args,
            created_at=row.created_at.isoformat(),
        )


class PromptIn(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)


def _state(request: Request) -> AppState:
    return cast(AppState, request.app.state.touchgrass)


@router.get("/sessions/{session_id}", response_model=SessionOut)
async def get_session(session_id: str, request: Request) -> SessionOut:
    state = _state(request)
    row = await asyncio.to_thread(state.store.get_session, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "session not found")
    return SessionOut.from_row(row)


@router.get("/sessions/{session_id}/messages", response_model=list[MessageOut])
async def get_messages(
    session_id: str,
    request: Request,
    limit: int | None = Query(default=None, gt=0, le=500),
    before_id: int | None = Query(default=None, gt=0),
) -> list[MessageOut]:
    state = _state(request)
    row = await asyncio.to_thread(state.store.get_session, session_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "session not found")
    rows = await asyncio.to_thread(
        state.store.get_messages, session_id, limit=limit, before_id=before_id
    )
    return [MessageOut.from_row(r) for r in rows]


@router.post(
    "/sessions/{session_id}/prompts",
    status_code=status.HTTP_202_ACCEPTED,
)
async def submit_prompt(
    session_id: str, body: PromptIn, request: Request
) -> dict[str, str]:
    state = _state(request)
    hub = state.get_hub(session_id)
    if hub is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "session not active on this daemon"
        )
    await hub.submit_prompt(body.text)
    return {"status": "queued"}


class ChangelogOut(BaseModel):
    path: str


@router.post(
    "/sessions/{session_id}/changelog", response_model=ChangelogOut
)
async def write_session_changelog(session_id: str, request: Request) -> ChangelogOut:
    state = _state(request)
    session = await asyncio.to_thread(state.store.get_session, session_id)
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "session not found")
    project = state.project(session.project_name)
    if project is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            f"project {session.project_name!r} no longer in config",
        )

    messages = await asyncio.to_thread(state.store.get_messages, session_id)
    summary: str | None = None
    hub = state.get_hub(session_id)
    if hub is not None:
        summary = await hub.request_summary()

    out_path = await asyncio.to_thread(
        write_changelog,
        project_path=project.path,
        session=session,
        messages=messages,
        summary=summary,
    )
    return ChangelogOut(path=str(out_path))
