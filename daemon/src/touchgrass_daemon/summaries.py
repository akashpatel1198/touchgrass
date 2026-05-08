"""Ephemeral, one-shot file summaries via the Claude Agent SDK.

Used by the file-tree screen on the phone. Each call spins up a `query()`
generator, sends the file contents inline, and collects the assistant's text
turn into a single string. Turns are short and single-shot — we're not
building a stateful conversation here.

Tools are not granted: the SDK call gets the contents in the prompt, so it
should never need Read/Glob/etc. We don't pass `cwd` for the same reason — we
don't want the model wandering the file tree.

The SummaryGenerator Protocol lets tests inject a fake without touching the
real SDK (per CLAUDE.md, no real SDK calls in tests).
"""

from __future__ import annotations

import logging
from typing import Any, Protocol

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    PermissionResultDeny,
    TextBlock,
    ToolPermissionContext,
    query,
)

log = logging.getLogger(__name__)

# Cap how much we send — the model has its own context limit, but we want to
# keep latency reasonable on the phone. Files larger than this get truncated
# with a marker; the cache key is mtime so a re-summarize after edits still
# refreshes.
_MAX_PROMPT_BYTES = 60_000

_SYSTEM = (
    "You are summarizing a single source file for a developer skimming on "
    "their phone. Write 1-2 short paragraphs in plain prose: what the file "
    "does, the key exported symbols or behavior, and any notable subtlety. "
    "Do NOT include code blocks. Do NOT use markdown headers. Be concise."
)


class SummaryGenerator(Protocol):
    async def __call__(self, *, rel_path: str, contents: str) -> str: ...


async def _deny_all(
    tool_name: str, tool_input: dict[str, Any], context: ToolPermissionContext
) -> PermissionResultDeny:
    del tool_name, tool_input, context
    return PermissionResultDeny(message="summary calls don't get tools")


async def default_summary_generator(*, rel_path: str, contents: str) -> str:
    """Real SDK call. Production path; tests should inject a fake instead."""
    truncated = contents
    if len(contents.encode("utf-8")) > _MAX_PROMPT_BYTES:
        truncated = (
            contents.encode("utf-8")[:_MAX_PROMPT_BYTES].decode(
                "utf-8", errors="replace"
            )
            + "\n\n[…truncated for summary…]"
        )

    prompt = (
        f"File: {rel_path}\n\n"
        f"{truncated}\n\n"
        "Summarize this file as instructed."
    )
    options = ClaudeAgentOptions(
        system_prompt=_SYSTEM,
        can_use_tool=_deny_all,
        max_turns=1,
    )

    chunks: list[str] = []
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    chunks.append(block.text)
    text = "".join(chunks).strip()
    if not text:
        log.warning("summary call returned no text for %s", rel_path)
        return "(summary unavailable)"
    return text
