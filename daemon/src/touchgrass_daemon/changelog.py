"""Per-session changelog writer for desktop resumption.

When a session ends (or on demand via API), we write
`<project>/.touchgrass/sessions/<session-id>.md` with goal, status, summary,
files touched, open threads, and next steps. The user opens that file in a
fresh Claude Code instance at their desk and resumes context in seconds.

The "summary, files touched, open threads, next steps" body is normally
provided by Claude itself (one final SDK turn before close, prompt template at
`prompts/session_summary.md`). If that fails — SDK error, no client connected,
empty response — we fall back to a templated body built from the message log
(file paths extracted from tool calls; last assistant message as summary).

`.touchgrass/` is appended to the project's `.gitignore` on first write so
changelogs don't end up in version control by default.
"""

from __future__ import annotations

import json
import logging
from importlib import resources
from pathlib import Path

from .store import Message, Session

log = logging.getLogger(__name__)

CHANGELOG_DIR = ".touchgrass/sessions"
GITIGNORE_ENTRY = ".touchgrass/"
_FALLBACK_SUMMARY_CHARS = 600


def load_summary_prompt() -> str:
    return (
        resources.files("touchgrass_daemon")
        .joinpath("prompts/session_summary.md")
        .read_text()
    )


def write_changelog(
    *,
    project_path: Path,
    session: Session,
    messages: list[Message],
    summary: str | None,
) -> Path:
    """Write the changelog file and ensure `.touchgrass/` is gitignored.

    `summary` is the Claude-generated body if available, otherwise None — we'll
    template a fallback. Returns the absolute path of the written file.
    """
    sessions_dir = project_path / CHANGELOG_DIR
    sessions_dir.mkdir(parents=True, exist_ok=True)

    body = build_changelog_markdown(session, messages, summary)
    out_path = sessions_dir / f"{session.id}.md"
    out_path.write_text(body)

    ensure_gitignore_entry(project_path, GITIGNORE_ENTRY)
    return out_path


def build_changelog_markdown(
    session: Session, messages: list[Message], summary: str | None
) -> str:
    title = _format_title(session)
    body = (summary or "").strip() or _fallback_body(messages)

    lines = [
        f"# {title}",
        "",
        f"**Goal:** {session.goal or '(no goal)'}",
        f"**Status:** {session.status}",
        f"**Session id:** `{session.id}`",
        "",
        body,
        "",
    ]
    return "\n".join(lines)


def _format_title(session: Session) -> str:
    timestamp = session.created_at.strftime("%Y-%m-%d %H:%M")
    if session.goal:
        # Trim long goals so the title doesn't wrap awkwardly in editors.
        goal_preview = session.goal.strip().splitlines()[0][:60]
        return f"Session {timestamp} — {goal_preview}"
    return f"Session {timestamp}"


def _fallback_body(messages: list[Message]) -> str:
    """Templated body when the SDK summary is unavailable."""
    files = sorted(_extract_files_touched(messages))
    last_assistant = _last_assistant_text(messages)
    return "\n".join(
        [
            "## Summary",
            (
                last_assistant[:_FALLBACK_SUMMARY_CHARS]
                if last_assistant
                else "_No assistant turns in this session._"
            ),
            "",
            "## Files touched",
            *([f"- {f}" for f in files] or ["_None detected._"]),
            "",
            "## Open threads",
            "_Auto-generated fallback — Claude summary unavailable. Review the transcript "
            "for unresolved items._",
            "",
            "## Next steps",
            "_Auto-generated fallback — Claude summary unavailable._",
        ]
    )


def _extract_files_touched(messages: list[Message]) -> set[str]:
    """Pull file paths out of `tool_call` rows. Best-effort, swallow malformed JSON."""
    files: set[str] = set()
    for m in messages:
        if m.role != "tool_call" or not m.tool_args:
            continue
        try:
            args = json.loads(m.tool_args)
        except (TypeError, ValueError):
            continue
        if not isinstance(args, dict):
            continue
        for key in ("file_path", "path", "notebook_path"):
            value = args.get(key)
            if isinstance(value, str) and value:
                files.add(value)
                break
    return files


def _last_assistant_text(messages: list[Message]) -> str:
    for m in reversed(messages):
        if m.role == "assistant" and m.content:
            return m.content
    return ""


def ensure_gitignore_entry(project_path: Path, entry: str) -> None:
    """Append `entry` to `<project>/.gitignore` if it isn't already there.

    Idempotent. Doesn't clobber existing content. Creates `.gitignore` if missing.
    """
    gitignore = project_path / ".gitignore"
    target = entry.rstrip("/")
    if gitignore.exists():
        existing = gitignore.read_text()
        for line in existing.splitlines():
            stripped = line.strip().rstrip("/")
            if stripped == target:
                return
        new_content = existing.rstrip() + f"\n{entry}\n"
        gitignore.write_text(new_content)
    else:
        gitignore.write_text(f"{entry}\n")
