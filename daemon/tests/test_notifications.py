from __future__ import annotations

from typing import Any

import httpx
import pytest

from touchgrass_daemon.notifications import NtfyClient


def _stub_client(
    *,
    response: httpx.Response | None = None,
    raise_exc: Exception | None = None,
) -> tuple[httpx.AsyncClient, list[dict[str, Any]]]:
    """Build an httpx client whose POSTs are captured into a list."""
    captured: list[dict[str, Any]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        captured.append(
            {
                "url": str(request.url),
                "headers": dict(request.headers),
                "body": request.content.decode("utf-8"),
            }
        )
        if raise_exc is not None:
            raise raise_exc
        return response or httpx.Response(200)

    transport = httpx.MockTransport(handler)
    return httpx.AsyncClient(transport=transport), captured


@pytest.mark.asyncio
async def test_permission_request_payload_shape() -> None:
    client, captured = _stub_client()
    ntfy = NtfyClient("touchgrass-test", client=client)

    await ntfy.notify_permission_request(
        session_id="sess-1",
        project_name="myproj",
        tool_name="Bash",
        tool_args={"cmd": "ls"},
        request_id="req-9",
    )

    assert len(captured) == 1
    sent = captured[0]
    assert sent["url"] == "https://ntfy.sh/touchgrass-test"
    assert sent["headers"]["title"] == "Permission needed"
    assert "Bash on myproj" in sent["body"]
    assert sent["headers"]["click"] == "touchgrass://sessions/sess-1?permission=req-9"
    assert "lock" in sent["headers"]["tags"]


@pytest.mark.asyncio
async def test_session_complete_payload_shape() -> None:
    client, captured = _stub_client()
    ntfy = NtfyClient("touchgrass-test", client=client)

    await ntfy.notify_session_complete(
        session_id="sess-2",
        project_name="myproj",
        goal="fix the auth bug",
        status="completed",
    )

    assert captured[0]["headers"]["title"] == "Session complete"
    assert "fix the auth bug" in captured[0]["body"]
    assert captured[0]["headers"]["click"] == "touchgrass://sessions/sess-2"


@pytest.mark.asyncio
async def test_session_failed_uses_failure_title() -> None:
    client, captured = _stub_client()
    ntfy = NtfyClient("topic", client=client)

    await ntfy.notify_session_complete(
        session_id="s",
        project_name="p",
        goal=None,
        status="failed",
    )

    assert captured[0]["headers"]["title"] == "Session failed"
    assert "(no goal)" in captured[0]["body"]


@pytest.mark.asyncio
async def test_http_error_does_not_propagate() -> None:
    client, _captured = _stub_client(
        raise_exc=httpx.ConnectError("ntfy.sh unreachable")
    )
    ntfy = NtfyClient("topic", client=client)

    # Must not raise — best-effort by design.
    await ntfy.notify_permission_request(
        session_id="s",
        project_name="p",
        tool_name="Bash",
        tool_args={},
        request_id="r",
    )


@pytest.mark.asyncio
async def test_4xx_is_logged_not_raised() -> None:
    client, _ = _stub_client(response=httpx.Response(429, text="rate limited"))
    ntfy = NtfyClient("topic", client=client)
    await ntfy.notify_permission_request(
        session_id="s",
        project_name="p",
        tool_name="Bash",
        tool_args={},
        request_id="r",
    )


@pytest.mark.asyncio
async def test_long_args_get_truncated() -> None:
    client, captured = _stub_client()
    ntfy = NtfyClient("topic", client=client)

    huge_args = {"cmd": "x" * 500}
    await ntfy.notify_permission_request(
        session_id="s",
        project_name="p",
        tool_name="Bash",
        tool_args=huge_args,
        request_id="r",
    )

    body = captured[0]["body"]
    # Body itself can exceed 80 once you include the prefix; the args preview
    # alone is what gets capped.
    assert len(body) < 200
    assert body.endswith("…")
