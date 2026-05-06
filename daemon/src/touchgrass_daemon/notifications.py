"""ntfy.sh push notifications for events worth waking the phone for.

Best-effort by design. ntfy is a public service with no SLA — if a POST fails,
the daemon logs a warning and moves on. Permissions still queue in SQLite and
can be approved over the WebSocket regardless of ntfy availability. Don't add
retry logic here that could stall the broker on a slow ntfy endpoint.

The `Click` URL uses our `touchgrass://` scheme. The phone app (phase 4)
parses it; for phase-2 testing, it just shows up as a clickable link in the
ntfy.sh browser tab.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx

log = logging.getLogger(__name__)

NTFY_BASE_URL = "https://ntfy.sh"
_REQUEST_TIMEOUT = 10.0
_BODY_PREVIEW_CHARS = 80


class NtfyClient:
    def __init__(
        self,
        topic: str,
        *,
        base_url: str = NTFY_BASE_URL,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self._topic = topic
        self._url = f"{base_url.rstrip('/')}/{topic}"
        self._client = client or httpx.AsyncClient(timeout=_REQUEST_TIMEOUT)
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def notify_permission_request(
        self,
        *,
        session_id: str,
        project_name: str,
        tool_name: str,
        tool_args: dict[str, Any],
        request_id: str,
    ) -> None:
        body = f"{tool_name} on {project_name}: {_preview(tool_args)}"
        await self._post(
            title="Permission needed",
            body=body,
            click=f"touchgrass://sessions/{session_id}?permission={request_id}",
            tags=["lock", "warning"],
            priority="high",
        )

    async def notify_session_complete(
        self,
        *,
        session_id: str,
        project_name: str,
        goal: str | None,
        status: str,
    ) -> None:
        body = f"{project_name}: {goal or '(no goal)'}"
        title = "Session complete" if status == "completed" else "Session failed"
        tags = ["white_check_mark"] if status == "completed" else ["x"]
        await self._post(
            title=title,
            body=body,
            click=f"touchgrass://sessions/{session_id}",
            tags=tags,
            priority="default",
        )

    async def _post(
        self,
        *,
        title: str,
        body: str,
        click: str,
        tags: list[str],
        priority: str,
    ) -> None:
        try:
            response = await self._client.post(
                self._url,
                content=body.encode("utf-8"),
                headers={
                    "Title": title,
                    "Click": click,
                    "Tags": ",".join(tags),
                    "Priority": priority,
                },
            )
            if response.status_code >= 400:
                log.warning(
                    "ntfy returned %s for topic %s: %s",
                    response.status_code,
                    self._topic,
                    response.text[:200],
                )
        except httpx.HTTPError as exc:
            log.warning("ntfy POST failed (best-effort): %s", exc)
        except Exception:
            log.exception("unexpected ntfy failure (best-effort)")


def _preview(args: dict[str, Any]) -> str:
    """Render tool args as a one-line preview, truncated for notifications."""
    try:
        text = json.dumps(args, default=str, separators=(",", ":"))
    except (TypeError, ValueError):
        text = str(args)
    if len(text) > _BODY_PREVIEW_CHARS:
        return text[: _BODY_PREVIEW_CHARS - 1] + "…"
    return text
