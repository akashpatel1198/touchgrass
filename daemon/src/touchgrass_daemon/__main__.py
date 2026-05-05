"""Console-script entry point.

Loads `~/.touchgrass/config.yaml`, builds the FastAPI app, and serves it with
uvicorn on the configured bind address + port. The full ops-runner story
(`make dev` + caffeinate) lives in §6 of the phase-1 checklist.
"""

from __future__ import annotations

import logging
import sys

import uvicorn

from .api import create_app
from .config import Config, ConfigError


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    try:
        config = Config.load()
    except ConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc

    app = create_app(config)
    uvicorn.run(
        app,
        host=config.bind_address,
        port=config.port,
        log_config=None,
    )


if __name__ == "__main__":
    main()
