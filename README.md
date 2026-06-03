# claude-broker

A long-running local daemon that lets any process send work to a Claude Code
session and receive structured results back. Uses the Claude Code
[channels MCP protocol](https://code.claude.com/docs/en/channels-reference)
and exposes a plain HTTP API.

```
HTTP clients ──▶ broker (daemon) ──unix socket──▶ shim ──stdio──▶ Claude Code
```

- **broker** — one per machine, long-lived. Owns jobs, sessions, DB, HTTP.
- **shim** — one per Claude session, spawned by Claude Code as an MCP server.
- **session** — an attached Claude session, addressed by id or label.
- **job** — one request to a session: `pending → dispatched → in_progress → completed | failed | cancelled | expired | orphaned`.

For a protocol-level walkthrough (HTTP → unix socket → MCP → Claude, end-to-end), see [docs/how-it-works.md](./docs/how-it-works.md).

## Requirements

- Claude Code v2.1.80+
- Node.js 20+
- The `--dangerously-load-development-channels` flag (research-preview feature).

## Quick start

```bash
# 1. Install
curl -fsSL https://raw.githubusercontent.com/rw3iss/claude-broker/main/install.sh | bash

# 2. Start the daemon
export CLAUDE_BROKER_TOKEN=$(openssl rand -hex 16)
claude-broker daemon start --detach

# 3. Register the shim as an MCP server for Claude Code
claude mcp add claude-broker -s user \
  -e CLAUDE_BROKER_SESSION_LABEL=default \
  -- claude-broker shim

# 4. Start a Claude session with the channel enabled
claude --dangerously-load-development-channels server:claude-broker

# 5. Submit a job from anywhere
curl -sS -X POST http://127.0.0.1:4180/jobs \
  -H "Authorization: Bearer $CLAUDE_BROKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"session_label":"default","content":"What time is it?"}'
```

## Install

One-liner installer (clones, builds, symlinks `claude-broker` into `~/.local/bin`):

```bash
curl -fsSL https://raw.githubusercontent.com/rw3iss/claude-broker/main/install.sh | bash
```

Update an existing install — easiest way:

```bash
claude-broker update
```

This re-runs the local `install.sh --update` (git fetch + rebuild) without
needing to remember the curl URL. Pass `--remote` to re-fetch the installer
from GitHub instead. Equivalent long form:

```bash
curl -fsSL https://raw.githubusercontent.com/rw3iss/claude-broker/main/install.sh | bash -s -- --update
```

Installer flags: `--prefix`, `--bin-dir`, `--ref`, `--repo`. Same names work
on `claude-broker update`. Run with `--help` for all options.
For a manual install from a working tree see [Development](#development).

## Daemon

The broker is a long-lived background service. **Prefer a systemd service** to
run it — it restarts on crash/boot and lets systemd own the socket cleanly. The
manual `daemon start` commands are for development or quick tests.

> The daemon is **not** the shim. `claude-broker shim` is the per-session MCP
> subprocess that Claude Code spawns for you (see [MCP setup](#mcp-setup)) — you
> never run it by hand. "Starting the daemon" only ever means the background
> broker below.

### systemd (recommended)

Put the token and any logging env in `/etc/claude-broker.env`:

```ini
CLAUDE_BROKER_TOKEN=replace-with-a-secret
# Turn per-session job logging on by default for the daemon:
CLAUDE_BROKER_LOG_SESSIONS=1
# Optional overrides:
# CLAUDE_BROKER_LOG_DIR=/var/log/claude-broker
# CLAUDE_BROKER_LOG_MAX_BYTES=5242880
# CLAUDE_BROKER_LOG_RETAIN_DAYS=7
```

`/etc/systemd/system/claude-broker.service`:

```ini
[Unit]
Description=claude-broker daemon
After=network.target

[Service]
Type=simple
User=youruser
Group=youruser
EnvironmentFile=/etc/claude-broker.env
Environment=PATH=/home/youruser/.local/bin:/usr/local/bin:/usr/bin:/bin
# Clear a stale socket left by an unclean shutdown before binding.
ExecStartPre=/bin/rm -f /tmp/claude-broker.sock
ExecStart=/home/youruser/.local/bin/claude-broker daemon start
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now claude-broker
sudo systemctl status claude-broker
journalctl -u claude-broker -f
```

Because `CLAUDE_BROKER_LOG_SESSIONS=1` is in the env file, session logging is on
for every session (equivalently, append `--log-sessions` to `ExecStart`). View
it with `claude-broker logs <session>` — see [Session logging](#session-logging).

No root? A user service works the same: drop the unit in
`~/.config/systemd/user/`, drop `User=`/`Group=`, set
`WantedBy=default.target`, and use `systemctl --user enable --now claude-broker`.

### Manual (development)

```bash
claude-broker daemon start                # foreground, logs to stdout
claude-broker daemon start --detach       # background; pidfile under $XDG_RUNTIME_DIR or /tmp
claude-broker daemon start --log-sessions # with session logging on
claude-broker daemon stop                 # SIGTERM the pidfile's process
claude-broker daemon status               # GET /healthz
```

> Pick one owner. If a systemd service runs the daemon, don't also
> `daemon start` by hand — the second one safely fails on the bound port
> (it won't disturb the running daemon), but it's avoidable noise.

## MCP setup

The shim is an MCP server. Each Claude Code session you want to address through
the broker must register it. The shim attaches the session to the broker on
startup and pumps `complete_job` / `fail_job` / `note_progress` tool calls.

### Option A — `claude mcp add` (recommended)

```bash
claude mcp add claude-broker -s user \
  -e CLAUDE_BROKER_SESSION_LABEL=default \
  -- claude-broker shim
```

- `-s user` writes `~/.claude.json` (top-level dotfile, *not* `~/.claude/`).
- `-s project` writes `.mcp.json` in the current directory.
- Args after `--` are passed to the shim.

### Option B — edit `~/.claude.json` by hand

```json
{
  "mcpServers": {
    "claude-broker": {
      "command": "claude-broker",
      "args": ["shim"],
      "env": {
        "CLAUDE_BROKER_SOCKET": "/tmp/claude-broker.sock",
        "CLAUDE_BROKER_SESSION_LABEL": "default",
        "CLAUDE_BROKER_SESSION_ID": "fixed-session-id-optional",
        "CLAUDE_BROKER_INSTRUCTIONS_FILE": "/path/to/custom.yaml"
      }
    }
  }
}
```

All `env` entries are optional except for the value of `auth_token` on the
daemon side. See [Environment variables](#environment-variables) for what each
controls.

## Starting a Claude session

Once the MCP server is registered, start Claude with the dev-channels flag and
enable the `claude-broker` channel:

```bash
claude --dangerously-load-development-channels server:claude-broker
```

### Pinning a session id

Sessions are normally auto-assigned a nanoid. To keep the same id across
restarts (useful when other systems address it by id rather than label), set
`CLAUDE_BROKER_SESSION_ID` in the MCP `env` block, or pass `--session-id` to
the shim:

```json
"env": { "CLAUDE_BROKER_SESSION_ID": "trader-prod-1" }
```

You can also pin the human-readable label via `CLAUDE_BROKER_SESSION_LABEL`.
Multiple sessions may share the same label; submitters that target by label
get a deterministic pick.

## Submitting jobs

### From the CLI

```bash
claude-broker jobs submit \
  --session-label default \
  --content "Investigate slow /trade" \
  --wait
```

Useful flags: `--session <id>`, `--ttl <sec>`, `--priority high|normal|low`,
`--mode serial|fire-and-forget`, `--client-ref <key>` (idempotency),
`--meta key=value`, `--content-file <path>`, `--wait-timeout <sec>`.

### From HTTP (any language)

```bash
curl -sS -X POST http://127.0.0.1:4180/jobs \
  -H "Authorization: Bearer $CLAUDE_BROKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "session_label": "default",
    "content": "Summarize the last 24h of logs",
    "ttl_sec": 300,
    "priority": "normal",
    "mode": "serial"
  }'
```

### From another agent or program

The broker is the integration point — anything that can speak HTTP can submit
work to an attached Claude session. The MCP server (shim) is private to the
Claude session that spawned it; other agents address the **broker**, not the
shim.

Typical patterns:

- **Other Claude Code sessions** — register the same MCP server, then use any
  tool that can hit the broker over HTTP (`curl`, `fetch`, a custom MCP tool).
  Sessions become workers identified by label or id; submitters address them
  the same way.
- **External services (CI jobs, webhooks, IDE extensions, other LLM agents)** —
  POST to `/jobs` with a bearer token. See `examples/webhook.ts` for a tiny
  forwarder that turns every inbound HTTP POST into a channel job.
- **MCP-native clients** — register an MCP tool that wraps the HTTP API
  (`submit_job`, `wait_for_job`). Any MCP host (Claude Code, Claude Desktop,
  third-party agents) can then drive the broker without bespoke code.

Minimal Node example:

```ts
const r = await fetch('http://127.0.0.1:4180/jobs', {
  method: 'POST',
  headers: {
    'authorization': `Bearer ${process.env.CLAUDE_BROKER_TOKEN}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ session_label: 'default', content: 'do the thing' }),
});
const { job_id } = await r.json();
```

## Querying jobs

### CLI

```bash
claude-broker jobs list                                # all jobs
claude-broker jobs list --status pending,in_progress
claude-broker jobs list --session <id> --limit 100
claude-broker jobs get <job_id>
claude-broker jobs cancel <job_id>

claude-broker sessions list
claude-broker sessions list --status attached
claude-broker sessions get <session_id>
```

### HTTP

```bash
# Fetch a job
curl -H "Authorization: Bearer $CLAUDE_BROKER_TOKEN" \
  http://127.0.0.1:4180/jobs/<job_id>

# Block until terminal (long-poll)
curl -H "Authorization: Bearer $CLAUDE_BROKER_TOKEN" \
  "http://127.0.0.1:4180/jobs/<job_id>/wait?timeout=120"

# Live state-transition stream (SSE)
curl -N -H "Authorization: Bearer $CLAUDE_BROKER_TOKEN" \
  http://127.0.0.1:4180/jobs/<job_id>/stream

# Append a comment to a running job
curl -X POST -H "Authorization: Bearer $CLAUDE_BROKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"note":"also include the staging logs"}' \
  http://127.0.0.1:4180/jobs/<job_id>/comment
```

## Session logging

Two complementary logs, both **off by default**, sharing one per-session
directory (`<log-dir>/<session>/`):

- **Job I/O log** (`jobs.log`) — written by the **daemon**. The broker sees
  every job's input (`content` + `meta`) and output (`result`/`error`/progress),
  so this is a clean, structured JSONL record. It does **not** include Claude's
  terminal chat — the channel only carries the job, not the conversation.
- **Terminal transcript** (`transcript-<ts>.log`) — written by the **`cll`
  launcher**, which runs Claude inside a pty (via `script`) so the TUI stays
  interactive while the full session output is captured.

Log dir precedence: `CLAUDE_BROKER_LOG_DIR` → `logging.sessions.dir` →
`~/.local/state/claude-broker/logs`.

### Enable daemon job logging

```bash
# Per-run flag…
claude-broker daemon start --log-sessions
# …or env (works with --detach, systemd, etc.)
CLAUDE_BROKER_LOG_SESSIONS=1 claude-broker daemon start --detach
```

### Launch + log a full session (the `cll` shortcut)

Add the launcher to your shell profile once:

```bash
eval "$(claude-broker shell-init)"   # defines a `cll` function
```

Then start a logged, fully-interactive session in one command:

```bash
cll trader      # label defaults to "default"
# → prints the transcript path and the watch commands, then runs Claude live.
```

`cll` pins the session id/label to the log name, so the daemon's `jobs.log`
and the transcript land in the same `<log-dir>/trader/` folder. (A standalone
`scripts/cll.sh` is also provided if you'd rather not touch your profile.)

Transcript capture needs the `script` tool (it runs Claude in a pty so the TUI
stays interactive). It's preinstalled on most desktops but missing on minimal
servers — recent Fedora split it into its own package:

```bash
sudo dnf install -y util-linux-script     # Fedora
sudo apt  install -y bsdutils             # Debian/Ubuntu
```

If `script` is absent, `cll` still launches Claude (and the daemon job log
keeps working) — it just skips the transcript and prints the install hint.

### View, follow, and clear logs

```bash
claude-broker logs                      # the "default" session's job log
claude-broker logs trader               # session "trader"'s job log
claude-broker logs trader -n 50         # last 50 lines
claude-broker logs trader -f            # live-follow — watch a session externally
claude-broker logs trader --transcript  # the full Claude terminal transcript
claude-broker logs trader --transcript -f   # follow the transcript live
claude-broker logs trader --all         # include rolled archive segments
claude-broker logs list                 # which sessions have logs, with sizes

claude-broker logs clear trader              # delete session "trader"'s logs
claude-broker logs clear --all               # delete every session's logs
claude-broker logs clear --all --days-before 2   # only files older than 2 days
```

`claude-broker logs -h` prints the same examples. The command reads files
directly, so it works even when the daemon is stopped. To **watch a session
from another terminal**, just `claude-broker logs <session> -f` (job events) or
`--transcript -f` (full chat).

### Keeping files small (rotation + retention)

Each session's active `jobs.log` rolls to a timestamped archive
(`jobs.<ms>.log`) once it passes `CLAUDE_BROKER_LOG_MAX_BYTES` (default 5 MB),
then a fresh `jobs.log` continues. The active file name stays stable, so
`logs -f` (which uses `tail -F`) follows seamlessly across rolls, and archives
are preserved for history. Set `CLAUDE_BROKER_LOG_RETAIN_DAYS` to have the
daemon's sweeper auto-delete log files older than N days, or prune on demand
with `logs clear --days-before N`.

## Configuration

The broker reads YAML from `~/.config/claude-broker/config.yaml` (override with
`--config <path>`). Every value supports `${VAR}` or `${VAR:-fallback}`
interpolation so secrets stay in the environment.

Minimal config:

```yaml
broker:
  http:
    port: 4180
    auth_token: ${CLAUDE_BROKER_TOKEN}
  socket:
    path: /tmp/claude-broker.sock
```

Full schema and defaults live in [`config/default.yaml`](./config/default.yaml).

### YAML knobs

| Path | Default | Meaning |
|---|---|---|
| `broker.http.host` | `127.0.0.1` | HTTP bind address |
| `broker.http.port` | `4180` | HTTP port |
| `broker.http.auth_token` | (required) | Bearer token clients must send |
| `broker.socket.path` | `/tmp/claude-broker.sock` | Unix socket the shim dials |
| `broker.defaults.job_ttl_sec` | `300` | Default per-job TTL |
| `broker.defaults.heartbeat_timeout_sec` | `30` | Idle threshold before evicting a shim |
| `broker.defaults.sweep_interval_sec` | `30` | How often the sweeper runs |
| `broker.defaults.long_poll_max_sec` | `600` | Cap on `/jobs/:id/wait?timeout=` |
| `broker.defaults.client_ref_window_sec` | `86400` | Idempotency lookup window |
| `broker.defaults.orphan_grace_sec` | `120` | Grace before dispatched jobs on detached sessions are marked `orphaned` |
| `storage.job_store.driver` | `sqlite` | `sqlite` or (stub) `postgres` |
| `storage.job_store.sqlite.path` | `$HOME/.local/state/claude-broker/jobs.sqlite` | SQLite file location |
| `dispatch.driver` | `inproc` | `inproc` or (stub) `bullmq` |
| `logging.level` | `info` | `trace`/`debug`/`info`/`warn`/`error` |
| `logging.pretty` | `true` | Human-readable vs JSON logs |
| `logging.sessions.enabled` | `false` | Master switch for per-session job I/O logging |
| `logging.sessions.dir` | `$HOME/.local/state/claude-broker/logs` | Log root (`CLAUDE_BROKER_LOG_DIR` wins) |
| `logging.sessions.max_bytes` | `5242880` (5 MB) | Active `jobs.log` rolls to an archive past this size |
| `logging.sessions.retain_days` | (unset) | If set, the sweeper auto-deletes log files older than this |
| `instructions` | (see default.yaml) | Channel-protocol text appended to Claude's system prompt |
| `instructions_append` | — | Optional project-specific guidance appended after `instructions` |

### Environment variables

All variables read anywhere in the codebase, grouped by where they apply:

| Variable | Used by | Purpose |
|---|---|---|
| `CLAUDE_BROKER_TOKEN` | daemon + every client | Bearer token. Default value for `broker.http.auth_token`; clients send it as `Authorization: Bearer …`. |
| `CLAUDE_BROKER_MIGRATIONS_DIR` | daemon | Override the SQL migrations directory. Rare — the resolver auto-probes the common locations. |
| `CLAUDE_BROKER_SOCKET` | shim | Unix-socket path the shim dials. Default `/tmp/claude-broker.sock`. Must match `broker.socket.path`. |
| `CLAUDE_BROKER_SESSION_LABEL` | shim | Human-readable label assigned to the attached session. Recommended for label-based addressing. |
| `CLAUDE_BROKER_SESSION_ID` | shim | Pre-assigned stable session id. Omit to auto-generate a nanoid. |
| `CLAUDE_BROKER_INSTRUCTIONS_FILE` | shim | Path to a YAML file whose `instructions` (and optional `instructions_append`) override the shipped default. |
| `CLAUDE_BROKER_LOG_SESSIONS` | daemon | `1`/`true` enables per-session job I/O logging (same as `--log-sessions`). Default off. |
| `CLAUDE_BROKER_LOG_DIR` | daemon + `logs` cmd | Log root. Takes precedence over `logging.sessions.dir`. Default `~/.local/state/claude-broker/logs`. |
| `CLAUDE_BROKER_LOG_MAX_BYTES` | daemon | Roll size for each session's active `jobs.log`. Default `5242880` (5 MB). |
| `CLAUDE_BROKER_LOG_RETAIN_DAYS` | daemon | If set, the sweeper deletes log files older than this many days. |
| `BROKER` | `examples/*` clients | Base URL for the broker. Default `http://127.0.0.1:4180`. |
| `SESSION_LABEL` | `examples/webhook.ts` | Label every forwarded webhook job targets. |
| `PORT` | `examples/webhook.ts` | Port the webhook forwarder listens on. Default `4191`. |
| `XDG_RUNTIME_DIR` | daemon | Directory for the default pidfile path. Falls back to `os.tmpdir()`. |
| `CLAUDE_BROKER_PREFIX` | `install.sh` | Equivalent to `--prefix`. Default `~/.local/share/claude-broker`. |
| `CLAUDE_BROKER_BIN_DIR` | `install.sh` | Equivalent to `--bin-dir`. Default `~/.local/bin`. |
| `CLAUDE_BROKER_REF` | `install.sh` | Equivalent to `--ref`. Default `main`. |
| `CLAUDE_BROKER_REPO` | `install.sh` | Equivalent to `--repo`. Default the public GitHub URL. |

## HTTP API

| Method | Path | Description |
|---|---|---|
| `GET` | `/healthz` | Liveness probe |
| `GET` | `/metrics` | Prometheus metrics |
| `POST` | `/jobs` | Submit a job |
| `GET` | `/jobs` | List jobs (`?status=`, `?session_id=`, `?limit=`) |
| `GET` | `/jobs/:id` | Fetch a job |
| `GET` | `/jobs/:id/wait?timeout=N` | Long-poll until terminal |
| `GET` | `/jobs/:id/stream` | SSE stream of state transitions |
| `DELETE` | `/jobs/:id` | Cancel a job |
| `POST` | `/jobs/:id/comment` | Append a note to a running job |
| `GET` | `/sessions` | List sessions (`?status=`, `?label=`) |
| `GET` | `/sessions/:id` | Inspect a session |
| `DELETE` | `/sessions/:id` | Detach a session (does not kill Claude) |
| `POST` | `/sessions/spawn` | (optional) Spawn a new Claude session via the broker helper |

Schemas and full payload shapes: [docs/architecture.md](./docs/architecture.md).

## CLI reference

```
claude-broker daemon {start,stop,status}    # start: --log-sessions, --log-dir
claude-broker shim                          # invoked by Claude Code's MCP config
claude-broker jobs {list,get,submit,cancel}
claude-broker sessions {list,get,spawn,kill}
claude-broker logs [session] [-n N|-f|--transcript|--all]
claude-broker logs {list, clear [session] [--all] [--days-before N]}
claude-broker shell-init [--name cll]       # print the cll launcher function
claude-broker config {validate,show}
claude-broker update [--ref REF] [--remote] # git-pull + rebuild this install
```

## Examples

- `examples/one-shot.ts` — submit, wait, print result.
- `examples/webhook.ts` — forward every inbound HTTP POST as a job.
- `examples/from-shell.sh` — bash helper functions.

## Development

```bash
pnpm install
pnpm test
pnpm dev          # broker in foreground with file watch
pnpm typecheck
```

- [docs/how-it-works.md](./docs/how-it-works.md) — protocol walkthrough across all three legs (HTTP, unix socket, MCP).
- [docs/architecture.md](./docs/architecture.md) — module boundaries and SOLID accountability.
- [docs/adapters.md](./docs/adapters.md) — write a new `JobStore` or `JobDispatcher`.
- [docs/operations.md](./docs/operations.md) — systemd, log rotation, backup.

## Troubleshooting

**`Could not locate the bindings file` on `daemon start`** — `better-sqlite3`
didn't compile during install. pnpm 10 gates lifecycle scripts behind an
approval flow:

```bash
cd ~/.local/share/claude-broker/node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3
node-gyp rebuild
```

Needs `node-gyp`, `python3`, `make`, a C++ compiler. Fedora:
`sudo dnf install -y python3 make gcc-c++`. Debian/Ubuntu:
`sudo apt install -y python3 make g++`.

**`session not found` on submit** — no shim is attached for that label.
Start `claude --dangerously-load-development-channels server:claude-broker`
in a second terminal and re-submit.

**Job stays in `dispatched`, second job blocks in `pending`** — Claude
received the channel event but didn't call `complete_job`. Either the MCP
server's instructions weren't injected (restart Claude after `claude mcp add`),
or submit with `--mode fire-and-forget` so subsequent jobs don't serialize.

## Limitations (v1)

- Custom channels are a research-preview feature; sessions must be started
  with `--dangerously-load-development-channels`.
- One broker per machine.
- Serial-mode dispatch by default (one in-flight job per session).
- Static bearer-token auth only.

## License

MIT — see [LICENSE](./LICENSE).
