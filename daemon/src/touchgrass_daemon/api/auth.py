"""Bearer-token gate for REST and WebSocket endpoints.

Tailscale gates network reach; this is belt-and-suspenders. Constant-time comparison
because we're comparing user-supplied input to a secret.
"""

from __future__ import annotations

import hmac

from fastapi import HTTPException, Request, WebSocket, status

_AUTH_SCHEME = "Bearer"


def _extract_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split(maxsplit=1)
    if len(parts) != 2 or parts[0].lower() != _AUTH_SCHEME.lower():
        return None
    return parts[1].strip()


def require_bearer(request: Request) -> None:
    """FastAPI dependency: 401 unless `Authorization: Bearer <token>` matches config."""
    expected: str = request.app.state.config.bearer_token
    token = _extract_token(request.headers.get("authorization"))
    if token is None or not hmac.compare_digest(token, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or missing bearer token",
            headers={"WWW-Authenticate": _AUTH_SCHEME},
        )


async def authorize_websocket(websocket: WebSocket) -> bool:
    """Validate the bearer on a WebSocket connection. Closes with 4401 on failure."""
    expected: str = websocket.app.state.config.bearer_token
    token = _extract_token(websocket.headers.get("authorization"))
    if token is None or not hmac.compare_digest(token, expected):
        await websocket.close(code=4401, reason="invalid or missing bearer token")
        return False
    return True
