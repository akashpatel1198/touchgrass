"""Read-only file tree traversal scoped to a project root.

Two operations:
  - `list_directory(project_root, rel_path)` — single-level entries.
  - `read_file(project_root, rel_path, max_bytes)` — raw contents under a cap.

Both refuse to escape the project root. Symlinks resolve before the
containment check, so a symlink pointing at `/etc/passwd` is rejected.

Ignore handling is deliberately a degraded subset of gitignore semantics:
a hardcoded "always hide" set (`.git`, `.touchgrass`, common build dirs) plus
a project-local `.touchgrassignore` parsed line-by-line and matched via
`fnmatch` against either the entry name or its path relative to the project
root. No negation, no recursive `**`. Phone tree browsing isn't a place
where you need full gitignore — if a real friction surfaces, revisit.
"""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

EntryType = Literal["file", "dir"]

# Directories/files we never list, regardless of any project ignore file.
_DEFAULT_HIDE: frozenset[str] = frozenset(
    {
        ".git",
        ".touchgrass",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        ".DS_Store",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        ".tox",
        "dist",
        "build",
    }
)

_IGNORE_FILENAME = ".touchgrassignore"


@dataclass(frozen=True, slots=True)
class TreeEntry:
    name: str
    type: EntryType
    size: int | None  # None for directories


class PathError(Exception):
    """Raised for path-safety failures: traversal, missing, wrong type."""


@dataclass(frozen=True, slots=True)
class _IgnoreSet:
    patterns: tuple[str, ...]

    def matches(self, name: str, rel_path: str) -> bool:
        for pat in self.patterns:
            stripped = pat.rstrip("/")
            if fnmatch.fnmatch(name, stripped) or fnmatch.fnmatch(rel_path, stripped):
                return True
        return False


def _load_ignore(project_root: Path) -> _IgnoreSet:
    path = project_root / _IGNORE_FILENAME
    if not path.exists():
        return _IgnoreSet(patterns=())
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return _IgnoreSet(patterns=())
    patterns: list[str] = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        patterns.append(line)
    return _IgnoreSet(patterns=tuple(patterns))


def resolve_safe(project_root: Path, rel_path: str) -> Path:
    """Resolve `rel_path` against `project_root`, rejecting traversal/escape.

    Empty / "." / "/" all resolve to the project root.
    """
    project_root = project_root.resolve()
    rel = (rel_path or "").lstrip("/").strip()
    candidate = (project_root / rel).resolve() if rel else project_root
    try:
        candidate.relative_to(project_root)
    except ValueError as exc:
        raise PathError(f"path escapes project root: {rel_path!r}") from exc
    return candidate


def list_directory(project_root: Path, rel_path: str) -> list[TreeEntry]:
    """Return one directory's entries, sorted (dirs first, then files, both alpha)."""
    target = resolve_safe(project_root, rel_path)
    if not target.exists():
        raise PathError(f"path does not exist: {rel_path!r}")
    if not target.is_dir():
        raise PathError(f"path is not a directory: {rel_path!r}")

    ignore = _load_ignore(project_root.resolve())
    entries: list[TreeEntry] = []
    for child in target.iterdir():
        if child.name in _DEFAULT_HIDE:
            continue
        try:
            child_rel = str(child.resolve().relative_to(project_root.resolve()))
        except (ValueError, OSError):
            continue
        if ignore.matches(child.name, child_rel):
            continue
        try:
            is_dir = child.is_dir()
        except OSError:
            continue
        if is_dir:
            entries.append(TreeEntry(name=child.name, type="dir", size=None))
        else:
            try:
                size = child.stat().st_size
            except OSError:
                size = None
            entries.append(TreeEntry(name=child.name, type="file", size=size))

    entries.sort(key=lambda e: (e.type != "dir", e.name.lower()))
    return entries


@dataclass(frozen=True, slots=True)
class FileRead:
    contents: str
    size: int
    mtime: float


def read_file(project_root: Path, rel_path: str, *, max_bytes: int) -> FileRead:
    """Read a file's contents under a hard size cap. Raises `PathError` for
    missing/non-file/oversized."""
    target = resolve_safe(project_root, rel_path)
    if not target.exists():
        raise PathError(f"path does not exist: {rel_path!r}")
    if not target.is_file():
        raise PathError(f"path is not a file: {rel_path!r}")
    stat = target.stat()
    if stat.st_size > max_bytes:
        raise PathError(
            f"file too large ({stat.st_size} bytes; max {max_bytes})"
        )
    text = target.read_text(encoding="utf-8", errors="replace")
    return FileRead(contents=text, size=stat.st_size, mtime=stat.st_mtime)


def file_mtime(project_root: Path, rel_path: str) -> float:
    """Stat-only — used by the summary cache to test invalidation cheaply."""
    target = resolve_safe(project_root, rel_path)
    if not target.exists() or not target.is_file():
        raise PathError(f"path is not a file: {rel_path!r}")
    return target.stat().st_mtime
