from __future__ import annotations

import asyncio
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from ...store import Session as SessionRow
from ..auth import require_bearer
from ..state import AppState

router = APIRouter(dependencies=[Depends(require_bearer)])


class ProjectOut(BaseModel):
    name: str
    path: str


class SessionOut(BaseModel):
    id: str
    project_name: str
    goal: str | None
    status: str
    created_at: str

    @classmethod
    def from_row(cls, row: SessionRow) -> SessionOut:
        return cls(
            id=row.id,
            project_name=row.project_name,
            goal=row.goal,
            status=row.status,
            created_at=row.created_at.isoformat(),
        )


class CreateSessionIn(BaseModel):
    goal: str | None = Field(default=None, max_length=2000)


class CreateSessionOut(BaseModel):
    session_id: str


def _state(request: Request) -> AppState:
    return cast(AppState, request.app.state.touchgrass)


@router.get("/projects", response_model=list[ProjectOut])
async def list_projects(request: Request) -> list[ProjectOut]:
    state = _state(request)
    return [ProjectOut(name=p.name, path=str(p.path)) for p in state.config.projects]


@router.get("/projects/{name}/sessions", response_model=list[SessionOut])
async def list_project_sessions(name: str, request: Request) -> list[SessionOut]:
    state = _state(request)
    if state.project(name) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown project: {name}")
    rows = await asyncio.to_thread(state.store.list_sessions, name)
    return [SessionOut.from_row(r) for r in rows]


@router.post(
    "/projects/{name}/sessions",
    response_model=CreateSessionOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_session(
    name: str, body: CreateSessionIn, request: Request
) -> CreateSessionOut:
    state = _state(request)
    project = state.project(name)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown project: {name}")
    hub = await state.start_session(project, goal=body.goal)
    return CreateSessionOut(session_id=hub.session_id)
