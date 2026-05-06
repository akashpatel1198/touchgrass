# touchgrass-daemon

Python daemon that wraps the Claude Code SDK programmatically and exposes a WebSocket + REST API for remote control. See the root `README.md` (lands in phase 4) for the full project context.

## Tooling

This package uses [`uv`](https://docs.astral.sh/uv/) for dependency and environment management.

```bash
# From the repo root
cd daemon
uv sync                      # creates .venv, installs project + dev deps
uv run touchgrass-daemon     # runs the console script
uv run pytest                # runs tests
uv run mypy                  # typecheck
uv run ruff check            # lint
```

If you prefer plain pip:

```bash
cd daemon
python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
```

## Don't skip this — sleep prevention

If your laptop sleeps while a session is running, the SDK process dies, in-flight
tool calls are orphaned, and any pending permission requests time out to deny.
Always run the daemon under a sleep-prevention shim. The repo-root `make dev`
target picks the right one for your OS:

- **macOS:** `caffeinate -i uv run touchgrass-daemon`
- **Linux:** `systemd-inhibit --what=sleep uv run touchgrass-daemon`

You can verify macOS isn't sleeping with:

```bash
pmset -g assertions | grep PreventUserIdleSystemSleep
```

## Layout

```
daemon/
├── pyproject.toml
├── src/touchgrass_daemon/    # package source
│   ├── __init__.py
│   └── __main__.py
└── tests/
```
