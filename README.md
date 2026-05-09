# touchgrass

> Claude Code keeps coding while you touch grass.

Remote-control your Claude Code sessions from your phone. Fire off prompts from the gym, approve permissions on a walk, and read what got done before you sit back down at your desk.

## The problem

You start a long-running Claude Code task, step away, come back twenty minutes later, and find it's been stuck on a permission prompt for nineteen of them.

Or you're at the gym between sets, you remember a one-line fix you wanted to try, but it's on your laptop, and you're not.

`touchgrass` is a personal tool for keeping Claude Code productive while you're away from your desk. A small daemon runs on your computer and pairs with a phone app over your private Tailscale network. From the phone you can:

- Send prompts to live sessions and watch the responses stream in
- Approve or deny tool-use permissions with a tap (Allow once / Allow for project / Deny)
- Get push notifications when a session needs you, via ntfy.sh
- Browse the project file tree with one-paragraph AI summaries on tap
- Pick up at your desk via a structured changelog Claude writes to each repo

Your laptop does the work. Your phone is the remote.

## How it works

```
┌──────────────┐         ┌─────────────────────────┐         ┌────────────────┐
│  Phone (RN)  │  ◄───►  │  Your computer          │  ◄───►  │  Claude Code   │
│              │         │   ├─ touchgrass daemon  │   SDK   │  (subprocess)  │
│  - Chat UI   │         │   ├─ session storage    │         │                │
│  - File tree │         │   └─ permission broker  │         └────────────────┘
│  - Approvals │         │                         │
└──────────────┘         └─────────────────────────┘
        ▲                            │
        │                            │
        │   Tailscale (private mesh) │
        └────────────────────────────┘
                                     │
                                     ▼
                              ┌──────────────┐
                              │   ntfy.sh    │
                              │ (push notif) │
                              └──────────────┘
```

The pieces:

- **Tailscale**: your phone and computer join a private mesh network. No public URLs, no port forwarding, end-to-end encrypted. The daemon stays invisible to the public internet.
- **Python daemon**: wraps the Claude Agent SDK, manages sessions in SQLite, intercepts permission requests, exposes a small WebSocket + REST API gated by a bearer token.
- **React Native phone app** (Expo, Android-first): chat UI, file tree, permission modal, local PIN gate.
- **ntfy.sh**: push notifications without app-store registration. The daemon POSTs to your topic; the official ntfy app on your phone delivers the OS-level push and deep-links into touchgrass on tap.
- **Claude Agent SDK** (not the CLI): the daemon owns the session programmatically, no terminal window required.

## Setup

> **Don't skip the sleep-prevention step.** If your laptop sleeps mid-session the SDK process dies and any in-flight tool calls are orphaned. The `make dev` target wraps the daemon in `caffeinate -i` on macOS or `systemd-inhibit --what=sleep` on Linux. If you start the daemon some other way, run it under one of those yourself.

### Prerequisites

- macOS or Linux for the daemon (Windows untested)
- Python 3.11+, [`uv`](https://github.com/astral-sh/uv) for the daemon's toolchain
- Node.js 20+ for the phone app
- A Claude Pro or Max subscription
- An Android phone with the Expo Go and ntfy apps installed
- Tailscale on both devices, logged into the same account

### 1. Daemon

```bash
git clone https://github.com/<you>/touchgrass.git
cd touchgrass/daemon
uv sync
```

Generate a long-lived OAuth token tied to your subscription, and put it in your shell profile so the daemon picks it up:

```bash
claude setup-token
# copy the printed token (starts with sk-ant-oat...)
echo 'export CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-..."' >> ~/.zshrc
source ~/.zshrc
```

Create the config (see [Configuration](#configuration) for the full schema):

```bash
mkdir -p ~/.touchgrass
cp config.example.yaml ~/.touchgrass/config.yaml
$EDITOR ~/.touchgrass/config.yaml
```

Run it under sleep-prevention from the repo root:

```bash
make dev
```

You should see `Uvicorn running on http://0.0.0.0:8765`.

### 2. Tailscale

Install Tailscale on the laptop and the phone, log both into the same account, and grab the laptop's tailnet IP:

```bash
tailscale ip -4
# 100.80.23.61   (yours will differ)
```

That IP is the address the phone app talks to. It's stable per-device on the tailnet and survives Wi-Fi changes.

### 3. Phone app

```bash
cd app
npm install
npx expo start
```

Scan the QR code with Expo Go. On first launch the app collects:

1. **Daemon URL**: `http://<your-tailnet-ip>:8765`
2. **Bearer token**: the `bearer_token` value from `~/.touchgrass/config.yaml`
3. **ntfy topic**: the same topic from your config

It runs `GET /health` against the daemon before saving anything. Then you set a 6-digit PIN and you're in.

For push notifications, open the ntfy Android app and subscribe to the same topic. Tapping a permission notification deep-links into touchgrass at the right modal.

> **One human, one subscription.** Anthropic's terms expect a Pro/Max OAuth token to be used by one person. touchgrass assumes *you* on *your* phone controlling *your* computer. Don't share the bearer token, don't run the daemon for someone else, don't put the OAuth token anywhere a teammate can read it. If you need a multi-user product, you're shopping for the API, not this.

## Configuration

`~/.touchgrass/config.yaml`:

```yaml
projects:
  - name: my-app
    path: ~/code/my-app
    pre_approved_tools: []   # tool names auto-allowed without prompting
    pre_denied_tools: []     # tool names auto-denied without prompting
  - name: side-project
    path: ~/code/side-project

ntfy:
  topic: touchgrass-<random-string>   # pick something unguessable

bearer_token: <run: openssl rand -hex 24>

permission_timeout_seconds: 300   # default-deny after this many seconds
bind_address: 0.0.0.0
port: 8765
```

A few notes:

- **Multi-project from day one.** There's no single-project shortcut; even one project goes in the list.
- **`bearer_token` must be at least 16 characters.** Tailscale already gates network reach; the bearer is belt-and-suspenders so a misconfigured tailnet ACL doesn't expose your daemon.
- **`ntfy.topic` is a shared secret.** Pick a long random string. Anyone who knows the topic can read your push notifications.
- **`pre_approved_tools` / `pre_denied_tools`** are scoped per project and short-circuit the permission flow before the broker fires anything to your phone.

## Permissions

The daemon uses a hybrid permission model:

1. The bundled Claude Code CLI handles routine auto-approval for read-only tools (Read, Glob, Grep, LS, ls-style Bash) and respects any allow patterns you have in `~/.claude/settings.json`. Same behavior you get running `claude` in a terminal.
2. Anything the CLI decides needs a prompt forwards to the touchgrass broker. The broker checks your `pre_approved_tools` / `pre_denied_tools` lists and short-circuits if there's a match.
3. Otherwise it queues the request, fires an ntfy push, and waits for you to tap one of:
   - **Allow once**: this single invocation goes through
   - **Allow for project**: this tool stays approved for the rest of the project's daemon lifetime (in-memory; reset on daemon restart)
   - **Deny**: the SDK is told no and the agent picks a different path

If `permission_timeout_seconds` elapses with no decision, the request defaults to deny. The phone modal closes with "already handled" if you open it after the timeout fired.

## Desktop resumption

When a session ends (cleanly or via failure) the daemon writes a markdown changelog to `<project>/.touchgrass/sessions/<session-id>.md`. Claude generates a summary in its own voice before disconnect; on the failure path you get a templated fallback so you still see *something*.

```markdown
# Session: 2026-05-04 14:22 (gym session)

**Goal:** Fix the auth redirect bug
**Status:** completed

## Summary
- Investigated /auth/callback flow, found state mismatch on redirect
- Added state validation in src/auth/callback.ts
- 3 tests still failing in auth.test.ts (not addressed in this session)

## Files touched
- src/auth/callback.ts
- src/auth/types.ts

## Open threads
- Failing tests in auth.test.ts
- TODO comment at callback.ts:47

## Next steps
- Investigate why the state cookie expires early
```

Walk back to your desk, point Claude Code (or the VSCode extension someday) at the latest session file, and you're back in context in under a minute.

`.touchgrass/` gets added to the project's `.gitignore` on first write.

## FAQ

**Why not just SSH in and run Claude Code in tmux?**
You can. This is for people who'd rather tap a notification than thumb-type `y` into a tmux pane between sets.

**Why not Claude.ai's web/mobile clients?**
Those are great products for chat-style workflows. touchgrass is for people who want code running on their own machine (local environment, secrets, dev servers) and just want a remote for it.

**Will this get me banned from my Claude subscription?**
No. You're using your own OAuth token to remote-control your own sessions for your own use. Sharing the token with anyone else is not within terms; don't do that.

**What if my laptop loses internet?**
The session keeps running locally. Queued notifications fire when the laptop reconnects. If a session needed permission while you were offline, it's still waiting (until the timeout).

**Why "touchgrass"?**
Because that's what you're doing.

## Contributing

Started as a personal scratch-my-own-itch project. PRs welcome, especially:

- iOS support (needs a Mac and an iPhone for testing)
- Bug fixes and tests
- Better file summarization
- Items in the [Later](ROADMAP.md#later) section of the roadmap

Open an issue first for anything bigger than a bug fix so we can align on direction.

## License

MIT. See [LICENSE](LICENSE).

## See also

- [`ROADMAP.md`](ROADMAP.md) for the in-progress feature list and the speculative `Later` section
- [`config.example.yaml`](config.example.yaml) for a copy-pasteable starting config
