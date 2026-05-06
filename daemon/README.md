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

## Reaching the daemon from your phone (Tailscale)

The daemon binds to `0.0.0.0` by default so any device on your tailnet can
reach it. Tailscale handles the encrypted private mesh; the bearer token in
`~/.touchgrass/config.yaml` gates access at the application layer.

Two layers, both required:

| Layer | What it stops |
|---|---|
| **Tailscale** | Anyone not on your tailnet from reaching the daemon at all |
| **Bearer token** | Anyone on your tailnet (other devices you own; people you've shared nodes with) from driving sessions on your behalf |

### Setup

1. **Install Tailscale on your laptop**: <https://tailscale.com/download> → log
   in with Google/GitHub/email/whatever you prefer. The free plan covers
   personal use.
2. **Install Tailscale on your phone**: same provider. Log in with the **same
   account** so both devices land in the same tailnet.
3. **Find your laptop's tailnet IP** by running on the laptop:
   ```bash
   tailscale ip -4
   ```
   You'll get something like `100.64.0.1` (the `100.x.y.z` range is Tailscale's
   private CGNAT block — these IPs are not reachable from the public internet).
4. **Point clients at that IP** instead of `localhost`:
   - Postman: in the collection variables, set `base_url` to
     `http://100.64.0.1:8765` (substituting your actual tailnet IP).
   - The phone app (phase 3+) takes the same IP in its first-run setup.
5. **Verify reach** by hitting `GET /health` from your phone or a second
   computer on the tailnet. Should return `{"status":"ok"}`. If not:
   - Confirm both devices show up in `tailscale status` on your laptop.
   - Confirm `make dev` is currently running.
   - Confirm the firewall isn't blocking inbound on the daemon port. macOS
     usually prompts on first run; allow it.

### Security notes

- **Don't share the bearer token.** It's in your config file alongside the
  ntfy topic; treat both as you would any API secret. The daemon refuses to
  start with a bearer shorter than 16 characters.
- **Don't expose the daemon port to the public internet.** No port forwarding,
  no reverse proxy, no ngrok. Tailscale routes everything through the encrypted
  mesh — that's the whole point.
- **One human, one subscription.** This is a personal tool. Don't paste your
  bearer token into a phone someone else uses, and don't run a multi-user
  daemon on someone else's behalf — that violates Anthropic's "one human, one
  subscription" rule.

## Layout

```
daemon/
├── pyproject.toml
├── postman/                  # Postman collection committed for easy import
├── src/touchgrass_daemon/    # package source
│   ├── api/                  # FastAPI app + routes + state
│   ├── store/                # SQLite session store + migrations
│   ├── prompts/              # SDK prompt templates (e.g. session summary)
│   ├── changelog.py          # per-session markdown writer
│   ├── config.py             # ~/.touchgrass/config.yaml schema
│   ├── events.py             # Event dataclass for runner ↔ API fan-out
│   ├── notifications.py      # ntfy.sh push client
│   ├── permissions.py        # PermissionBroker (allow/deny/decision)
│   ├── runner.py             # SessionRunner around the Claude Agent SDK
│   └── __main__.py           # console script entry point
└── tests/
```
