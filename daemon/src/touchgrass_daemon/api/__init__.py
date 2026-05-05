"""HTTP/WebSocket surface for the daemon."""

from .app import create_app

__all__ = ["create_app"]
