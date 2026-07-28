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

- Claude Code v2.1.80+ — sessions run with `--dangerously-load-development-channels server:claude-broker` and you accept its one-time prompt; the shim is a standard MCP server registered via `claude mcp add`.
- Node.js 20+
- `openssl` (to mint a token), and `claude` logged in to your account.

## Quick start

Local machine, from zero to a working session in about a minute:

```bash
# 1. Install (clones, builds, symlinks `claude-broker` into ~/.local/bin)
curl -fsSL https://raw.githubusercontent.com/rw3iss/claude-broker/main/install.sh | bash

# 2. Start the daemon with a token. Keep this token — the shim AND every client must send it.
export CLAUDE_BROKER_TOKEN=$(openssl rand -hex 16)
claude-broker daemon start --detach

# 3. Register the shim as an MCP server for Claude Code (user scope → ~/.claude.json)
claude mcp add claude-broker -s user \
  -e CLAUDE_BROKER_SESSION_LABEL=default \
  -- claude-broker shim

# 4. Start a Claude session with the broker channel enabled, and ACCEPT the one-time
#    "Loading development channels" prompt — that acceptance is what authorizes the channel.
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-broker
#   → select "I am using this for local development", press Enter.
#   /mcp lists "claude-broker"; the channel banner shows server:claude-broker with NO warning line.

# 5. Verify the session attached
curl -s http://127.0.0.1:4180/healthz        # → {"ok":true, ... ,"sessionCount":1}

# 6. Submit a job from anywhere
curl -sS -X POST http://127.0.0.1:4180/jobs \
  -H "Authorization: Bearer $CLAUDE_BROKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"session_label":"default","content":"What time is it?"}'
```

> **Two things are required, and both are easy to get subtly wrong:**
> (1) the shim **MCP server** (step 3) provides the `complete_job` / `note_progress` tools; and
> (2) `--dangerously-load-development-channels server:claude-broker` **plus accepting the
> confirmation** authorizes the channel so Claude injects the pushed jobs.
>
> Two gotchas that silently break it (jobs attach but go `dispatched → expired`):
> - **Don't also pass `--channels`** for the same channel — it adds a second, *un-authorized*
>   copy that Claude ignores (you'll see the channel listed twice with a persistent
>   *"server: entries need --dangerously-load-development-channels"* warning). The dev-channels
>   flag alone is correct.
> - **You must accept the prompt.** Acceptance is literally what sets the channel's `dev` flag
>   (Claude Code gates `server:` channels on it). A session left at the prompt, or launched
>   headless where it can't be accepted, never authorizes — so no `<channel>` events arrive.

## Initialize on a server (persistent)

Same flow as above, plus: the session must survive SSH disconnects, and the token
must be shared with any service that submits jobs.

1. **Install + log in.** Install `claude-broker` (above) and Claude Code
   (`npm i -g @anthropic-ai/claude-code`), then run `claude` once to log in.
2. **Run the daemon as a service** (systemd — see [Daemon](#daemon)) with the token
   in its env file. Confirm: `curl -s http://127.0.0.1:4180/healthz` → `{"ok":true,...}`.
3. **Register the shim** for the account that will host the session:
   `claude mcp add claude-broker -s user -e CLAUDE_BROKER_SESSION_LABEL=<label> -- claude-broker shim`.
4. **Start the session in tmux** so it outlives your shell:
   ```bash
   tmux new -s broker
   claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-broker
   #  → accept the "Loading development channels" prompt; leave it running; detach with Ctrl-b d
   ```
5. **Point your app at the broker.** Any service that submits jobs (an API gateway,
   a worker) needs `CLAUDE_BROKER_URL=http://127.0.0.1:4180` and the **same**
   `CLAUDE_BROKER_TOKEN` the daemon uses. Set both, then restart the service.
6. **Verify end-to-end:** `curl -s :4180/healthz` shows `sessionCount ≥ 1`, and a
   `POST /jobs` returns a result instead of `session not found`.

**Gotchas (learned the hard way):**

- **The token must match in three places** — the daemon's env/config, each client's
  `CLAUDE_BROKER_TOKEN`, and the shim's env. Any mismatch is a `401 unauthorized`.
- **MCP scope matters.** `claude mcp add -s user` writes `~/.claude.json`. A block
  placed in `~/.claude/.claude.json` (note the extra subdir) is **not read** — `/mcp`
  won't show it and no session attaches.
- **The session is a live `claude` process.** It must stay running (tmux/screen) and
  be at the main prompt to accept jobs. A shell running the CLI (`sessions list`,
  `jobs submit`) also needs `CLAUDE_BROKER_TOKEN` exported.

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

Installer flags: `--shell-init` (wire the `cll` transcript launcher into your
shell rc), `--prefix`, `--bin-dir`, `--ref`, `--repo`. Same names work on
`claude-broker update`. Run with `--help` for all options.
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

Once the shim MCP server is registered, start Claude with the broker channel
enabled and **accept the confirmation prompt** (that acceptance authorizes the
`server:` channel — see the gotchas in [Quick start](#quick-start)):

```bash
claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-broker
# → "Loading development channels": select "I am using this for local development", Enter
```

Inside Claude, `/mcp` lists **claude-broker**, and the channel banner should show
`server:claude-broker` **once with no warning**. From another shell,
`claude-broker sessions list` (or `GET /healthz` → `sessionCount`) confirms the
attach. On a server, run this inside `tmux`/`screen` so the session persists.

> If the banner still shows *"server: entries need --dangerously-load-development-channels"*,
> the channel isn't authorized — you either also passed `--channels` (drop it) or didn't
> accept the prompt. Until it's authorized, jobs attach but go `dispatched → expired`.

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
- **Terminal transcript** (`transcript-<ts>.log`) — the full Claude TUI output,
  captured by running the session inside a pty via `script` (see below).

Log dir precedence: `CLAUDE_BROKER_LOG_DIR` → `logging.sessions.dir` →
`~/.local/state/claude-broker/logs`.

### Enable daemon job logging

```bash
# Per-run flag…
claude-broker daemon start --log-sessions
# …or env (works with --detach, systemd, etc.)
CLAUDE_BROKER_LOG_SESSIONS=1 claude-broker daemon start --detach
```

The job I/O log is mechanism-independent — turn it on and every session's jobs
are recorded, viewable with `claude-broker logs <session>`.

### Capturing a full terminal transcript

The daemon job log doesn't include Claude's chat. To capture the whole TUI, run
the session inside `script` (a pty wrapper). The **`cll`** shortcut does exactly
that — the session still attaches via the registered shim MCP server; `cll` only
adds the pty + transcript (it needs the shim registered, like any session):

```bash
echo 'eval "$(claude-broker shell-init)"' >> ~/.bashrc   # or ~/.zshrc; reopen the shell
cll trader                                               # → prints the transcript path, runs Claude live
```

Or by hand, without touching your profile (equivalent to `scripts/cll.sh`):

```bash
label=trader
dir="$HOME/.local/state/claude-broker/logs/$label"; mkdir -p "$dir"
script -q -e -f -c "claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-broker" "$dir/transcript-$(date +%Y%m%d-%H%M%S).log"
```

`script` is preinstalled on most desktops but missing on minimal servers —
recent Fedora split it into its own package:

```bash
sudo dnf install -y util-linux-script     # Fedora
sudo apt  install -y bsdutils             # Debian/Ubuntu
```

If `script` is absent, `cll` still launches Claude (the daemon job log keeps
working) — it just skips the transcript.

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

## Auto-clearing session context

A long-lived worker session accumulates context as it processes jobs and
eventually runs out of tokens. The manual fix is to type `/clear` in the TUI
when the queue drains. Auto-clear does that for you.

**How it works (and why it's external).** The broker delivers jobs to Claude as
`notifications/claude/channel` events, which land as message *content* — a
`/clear` pushed down that channel would be read as literal text, not run as a
slash command. So the broker instead types the keys into the terminal the
session reads from, using tmux `send-keys` (or a custom command). This is an
*in-session* reset — the `claude` process keeps running and stays attached, so
**no in-flight job is dropped** (contrast a process restart, which would).

**When it fires.** On a timer, for each attached session, it clears when *all* of:

- at least `min_jobs` jobs have **finished** (completed/failed) since the last clear;
- the session has had **no job activity for `idle_sec`** seconds;
- the `cooldown_sec` debounce since the last clear has elapsed; and
- **no job is pending/dispatched/in_progress** — an authoritative store check, so it
  never clears mid-job.

Each clear is logged (`auto-cleared idle session context`).

**It's off by default** — keystroke injection is environment-specific and must
not fire blind. Turn it on (the session must run under **tmux** so the pane can be
auto-detected — the README's tmux / `cll` launch works):

```ini
# /etc/claude-broker.env  (or the daemon's env)
CLAUDE_BROKER_AUTO_CLEAR=1
# Optional tuning:
# CLAUDE_BROKER_AUTO_CLEAR_IDLE_SEC=180
# CLAUDE_BROKER_AUTO_CLEAR_MIN_JOBS=1
# CLAUDE_BROKER_AUTO_CLEAR_COOLDOWN_SEC=300
# Pin the pane if auto-detection can't find it:
# CLAUDE_BROKER_AUTO_CLEAR_TMUX_TARGET=broker:0.0
```

Find the pane target with `tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index}'`.
Auto-detection walks the session pid's process tree (shim → `claude` → the pane's
shell) to match a pane; if it can't (tmux not reachable, session not in tmux), set
`tmux_target` or a `command`.

**Custom injection.** Set `broker.auto_clear.command` (or
`CLAUDE_BROKER_AUTO_CLEAR_COMMAND`) to bypass tmux entirely — e.g. `screen -X` or a
script that writes to a pty. The command runs with `CLAUDE_BROKER_CLEAR_KEYS`,
`CLAUDE_BROKER_SESSION_ID`, `CLAUDE_BROKER_SESSION_LABEL`,
`CLAUDE_BROKER_SESSION_PID`, and `CLAUDE_BROKER_TMUX_TARGET` in its environment; a
non-zero exit is treated as a failed injection (retried next tick).

> **Restart vs. in-session clear.** Auto-clear is an in-session `/clear`, not a
> process restart — it needs a terminal to type into (tmux/pty). It does not kill
> or relaunch `claude`. If you instead want a hard reset, restart the session
> process yourself (e.g. in tmux); that drops any in-flight job and detaches until
> the session re-attaches.

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
| `broker.auto_clear.enabled` | `false` | Auto-reset an idle session's context (the automated `/clear`). See [Auto-clearing session context](#auto-clearing-session-context). |
| `broker.auto_clear.idle_sec` | `180` | Clear only after this many seconds of no job activity |
| `broker.auto_clear.min_jobs` | `1` | Require at least this many finished jobs since the last clear |
| `broker.auto_clear.cooldown_sec` | `300` | Never clear the same session more often than this |
| `broker.auto_clear.check_interval_sec` | `30` | How often the manager evaluates sessions |
| `broker.auto_clear.keys` | `/clear` | Keystrokes typed into the TUI to reset context |
| `broker.auto_clear.tmux_target` | (auto) | Explicit tmux pane (`session:window.pane` or session name); auto-detected from the session pid if unset |
| `broker.auto_clear.command` | — | Custom injection command; overrides the tmux path entirely |
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
| `CLAUDE_BROKER_AUTO_CLEAR` | daemon | `1`/`true` enables auto-clearing an idle session's context. Default off. See [Auto-clearing session context](#auto-clearing-session-context). |
| `CLAUDE_BROKER_AUTO_CLEAR_IDLE_SEC` | daemon | Seconds of no job activity before clearing. Default `180`. |
| `CLAUDE_BROKER_AUTO_CLEAR_MIN_JOBS` | daemon | Finished jobs required since the last clear. Default `1`. |
| `CLAUDE_BROKER_AUTO_CLEAR_COOLDOWN_SEC` | daemon | Minimum seconds between clears of one session. Default `300`. |
| `CLAUDE_BROKER_AUTO_CLEAR_TMUX_TARGET` | daemon | Explicit tmux pane to send-keys into. Default: auto-detect from the session pid. |
| `CLAUDE_BROKER_AUTO_CLEAR_COMMAND` | daemon | Custom injection command; overrides the tmux path. |
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
| `POST` | `/sessions/spawn` | Best-effort: spawns `claude` headless and waits for the shim to attach. A TUI may not initialise reliably headless — prefer starting `claude` yourself (tmux). |

Schemas and full payload shapes: [docs/architecture.md](./docs/architecture.md).

## CLI reference

```
claude-broker daemon {start,stop,status}    # start: --log-sessions, --log-dir
claude-broker shim                          # invoked by Claude Code's MCP config
claude-broker jobs {list,get,submit,cancel}
claude-broker sessions {list,get,spawn,kill}  # spawn = best-effort headless; prefer a manual `claude`
claude-broker logs [session] [-n N|-f|--transcript|--all]
claude-broker logs {list, clear [session] [--all] [--days-before N]}
claude-broker shell-init [--name cll]       # print the cll transcript launcher
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

**`session not found` on submit** — no session is attached for that label.
Confirm the shim MCP server is registered (`claude mcp add …`, `/mcp` lists
**claude-broker**), then start `claude --dangerously-skip-permissions
--dangerously-load-development-channels server:claude-broker` (accept the prompt)
and re-submit. On a server, keep it running in `tmux`.

**Jobs go `dispatched` then `expired`, never `completed`** — the session is
attached but the channel isn't **authorized**, so the pushed events never inject.
Check the channel banner: if it shows *"server: entries need
--dangerously-load-development-channels"*, the channel is `dev:false`. Fix it by
(a) launching with `--dangerously-load-development-channels server:claude-broker`,
(b) **accepting** the "Loading development channels" prompt (that's what sets `dev`),
and (c) **not** also passing `--channels` for the same channel (the duplicate stays
un-authorized and keeps the warning). Also make sure only **one** session holds the
target label — a stale/detached duplicate can win the label pick and swallow jobs
(`claude-broker sessions list`; submit by `--session <id>` to be exact).

**`401 unauthorized`** — the `CLAUDE_BROKER_TOKEN` the client (or shim) sends
doesn't match the daemon's. It must be identical in the daemon's env/config,
the shim's MCP `env`, and every client. Re-check all three and restart.

**`/mcp` doesn't list `claude-broker`** — the shim isn't registered where this
Claude reads config. Use `claude mcp add … -s user` (writes `~/.claude.json`);
a block in `~/.claude/.claude.json` (extra subdir) is ignored. Restart Claude.

**Job stays in `dispatched`, second job blocks in `pending`** — Claude
received the job event but didn't call `complete_job`. Either the MCP
server's instructions weren't injected (restart Claude after `claude mcp add`),
or submit with `--mode fire-and-forget` so subsequent jobs don't serialize.

## Limitations (v1)

- One broker per machine.
- Serial-mode dispatch by default (one in-flight job per session).
- Static bearer-token auth only.

## License

MIT — see [LICENSE](./LICENSE).
