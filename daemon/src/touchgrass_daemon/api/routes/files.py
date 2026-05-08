"""Read-only file tree + summary endpoints for the phone client.

Phone is not an editor — these endpoints exist to let the user see what
Claude is working on, not to edit it. There is no write path.

  GET /projects/{name}/tree?path=
      One directory's entries. Hidden by `.touchgrassignore` + a hardcoded
      always-hide set (see `files.py`).

  GET /projects/{name}/file?path=...&summary=true
      AI summary of one file. Cached by `(project, path, mtime)` in SQLite;
      mtime change invalidates.

  GET /projects/{name}/file?path=...&summary=false
      Raw file contents under a 1MB cap. No syntax highlighting; the phone
      isn't trying to be VS Code.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel

from ...files import (
    PathError,
    file_mtime,
    list_directory,
    read_file,
)
from ..auth import require_bearer
from ..state import AppState

router = APIRouter(dependencies=[Depends(require_bearer)])
log = logging.getLogger(__name__)

MAX_RAW_BYTES = 1_000_000


class TreeEntryOut(BaseModel):
    name: str
    type: str
    size: int | None = None


class FileSummaryOut(BaseModel):
    path: str
    summary: str
    cached: bool


class FileContentsOut(BaseModel):
    path: str
    contents: str
    size: int


def _state(request: Request) -> AppState:
    return cast(AppState, request.app.state.touchgrass)


@router.get(
    "/projects/{name}/tree",
    response_model=list[TreeEntryOut],
)
async def get_tree(
    name: str, request: Request, path: str = Query(default="")
) -> list[TreeEntryOut]:
    state = _state(request)
    project = state.project(name)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown project: {name}")
    try:
        entries = await asyncio.to_thread(list_directory, project.path, path)
    except PathError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return [
        TreeEntryOut(name=e.name, type=e.type, size=e.size) for e in entries
    ]


@router.get("/projects/{name}/file")
async def get_file(
    name: str,
    request: Request,
    path: str = Query(...),
    summary: bool = Query(default=False),
) -> FileSummaryOut | FileContentsOut:
    state = _state(request)
    project = state.project(name)
    if project is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown project: {name}")

    if summary:
        return await _summary(state, project_name=name, project_path=project.path, rel_path=path)
    return await _contents(project_path=project.path, rel_path=path)


async def _summary(
    state: AppState, *, project_name: str, project_path: Path, rel_path: str
) -> FileSummaryOut:
    try:
        mtime = await asyncio.to_thread(file_mtime, project_path, rel_path)
    except PathError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    cached = await asyncio.to_thread(
        state.store.get_file_summary, project_name, rel_path
    )
    if cached is not None and abs(cached[0] - mtime) < 1e-6:
        return FileSummaryOut(path=rel_path, summary=cached[1], cached=True)

    try:
        read = await asyncio.to_thread(
            read_file, project_path, rel_path, max_bytes=MAX_RAW_BYTES
        )
    except PathError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc

    summary_text = await state.summary_generator(
        rel_path=rel_path, contents=read.contents
    )
    await asyncio.to_thread(
        state.store.upsert_file_summary,
        project_name,
        rel_path,
        read.mtime,
        summary_text,
    )
    return FileSummaryOut(path=rel_path, summary=summary_text, cached=False)


async def _contents(*, project_path: Path, rel_path: str) -> FileContentsOut:
    try:
        read = await asyncio.to_thread(
            read_file, project_path, rel_path, max_bytes=MAX_RAW_BYTES
        )
    except PathError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return FileContentsOut(path=rel_path, contents=read.contents, size=read.size)
