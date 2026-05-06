from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from touchgrass_daemon.changelog import (
    GITIGNORE_ENTRY,
    build_changelog_markdown,
    ensure_gitignore_entry,
    load_summary_prompt,
    write_changelog,
)
from touchgrass_daemon.store import Message, Session


def _session(**overrides: object) -> Session:
    base: dict[str, object] = {
        "id": "abc-123",
        "project_name": "myproj",
        "goal": "fix the auth bug",
        "status": "completed",
        "created_at": datetime(2026, 5, 5, 14, 22, tzinfo=UTC),
    }
    base.update(overrides)
    return Session(**base)  # type: ignore[arg-type]


def _message(role: str, content: str, **overrides: object) -> Message:
    base: dict[str, object] = {
        "id": 1,
        "session_id": "abc-123",
        "role": role,
        "content": content,
        "tool_name": None,
        "tool_args": None,
        "created_at": datetime(2026, 5, 5, 14, 23, tzinfo=UTC),
    }
    base.update(overrides)
    return Message(**base)  # type: ignore[arg-type]


def test_build_uses_sdk_summary_when_provided() -> None:
    body = build_changelog_markdown(
        _session(),
        messages=[],
        summary="## Summary\nDid stuff.\n\n## Files touched\n- a.py",
    )
    assert "Goal:** fix the auth bug" in body
    assert "Status:** completed" in body
    assert "## Summary\nDid stuff." in body


def test_build_falls_back_when_summary_missing() -> None:
    messages = [
        _message(
            "tool_call",
            '{"file_path":"src/auth.py"}',
            tool_name="Read",
            tool_args='{"file_path":"src/auth.py"}',
        ),
        _message(
            "tool_call",
            '{"file_path":"src/auth.py","old_string":"x","new_string":"y"}',
            tool_name="Edit",
            tool_args='{"file_path":"src/auth.py","old_string":"x","new_string":"y"}',
        ),
        _message("assistant", "I fixed the auth state validation.", id=99),
    ]
    body = build_changelog_markdown(_session(), messages, summary=None)
    assert "I fixed the auth state validation." in body
    assert "- src/auth.py" in body
    assert "_Auto-generated fallback" in body  # marks the imperfect path


def test_build_falls_back_when_summary_empty() -> None:
    body = build_changelog_markdown(_session(), messages=[], summary="   \n   ")
    assert "_No assistant turns" in body


def test_extract_handles_malformed_tool_args() -> None:
    body = build_changelog_markdown(
        _session(),
        messages=[
            _message(
                "tool_call",
                "not-json",
                tool_name="Bash",
                tool_args="not-valid-json",
            ),
        ],
        summary=None,
    )
    assert "_None detected._" in body


def test_write_changelog_persists_and_creates_gitignore(tmp_path: Path) -> None:
    project = tmp_path / "proj"
    project.mkdir()
    out = write_changelog(
        project_path=project,
        session=_session(),
        messages=[_message("assistant", "ok")],
        summary="## Summary\nshipped",
    )
    assert out.exists()
    assert out.parent == project / ".touchgrass" / "sessions"
    assert out.read_text().startswith("# Session 2026-05-05 14:22 — fix the auth bug")
    gitignore = (project / ".gitignore").read_text()
    assert ".touchgrass/" in gitignore


def test_write_changelog_idempotent_gitignore(tmp_path: Path) -> None:
    project = tmp_path / "proj"
    project.mkdir()
    (project / ".gitignore").write_text("node_modules\n.touchgrass/\n")
    write_changelog(
        project_path=project,
        session=_session(),
        messages=[],
        summary="## Summary\nx",
    )
    body = (project / ".gitignore").read_text()
    assert body.count(".touchgrass/") == 1


def test_write_changelog_appends_to_existing_gitignore_without_entry(
    tmp_path: Path,
) -> None:
    project = tmp_path / "proj"
    project.mkdir()
    (project / ".gitignore").write_text("node_modules\n*.log\n")
    write_changelog(
        project_path=project,
        session=_session(),
        messages=[],
        summary="## Summary\nx",
    )
    body = (project / ".gitignore").read_text()
    # Existing lines preserved, new entry appended.
    assert "node_modules" in body
    assert "*.log" in body
    assert ".touchgrass/" in body


def test_ensure_gitignore_entry_matches_with_or_without_slash(
    tmp_path: Path,
) -> None:
    gitignore = tmp_path / ".gitignore"
    gitignore.write_text(".touchgrass\n")
    ensure_gitignore_entry(tmp_path, GITIGNORE_ENTRY)
    # Should not have appended; already covered by `.touchgrass` (no slash).
    assert gitignore.read_text() == ".touchgrass\n"


def test_load_summary_prompt_returns_template() -> None:
    prompt = load_summary_prompt()
    assert "## Summary" in prompt
    assert "## Files touched" in prompt
    assert "## Open threads" in prompt
    assert "## Next steps" in prompt
