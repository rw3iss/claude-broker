# Operations

## Running the broker

The broker is a long-lived background service. Run it under **systemd** — it
restarts on crash/boot and owns the socket cleanly. Let systemd be the single
owner; a stray `claude-broker daemon start` by hand just fails on the bound port
(harmless since v0.5.2, but avoidable). The shim (`claude-broker shim`) is a
separate per-session MCP subprocess Claude Code spawns — not something you start.

For development only:

```bash
pnpm dev                                   # foreground with file watch
claude-broker daemon start --detach        # background; pidfile under $XDG_RUNTIME_DIR or /tmp
claude-broker daemon stop                  # SIGTERM the pidfile's process
```

## systemd service (recommended)

Keep the token + logging env out of the unit, in `/etc/claude-broker.env`:

```ini
CLAUDE_BROKER_TOKEN=replace-with-a-secret
CLAUDE_BROKER_LOG_SESSIONS=1          # session logging on by default
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

A user service works without root: drop the unit in
`~/.config/systemd/user/claude-broker.service`, remove `User=`/`Group=`, set
`WantedBy=default.target`, and `systemctl --user enable --now claude-broker`.
(For a user service to survive logout, `loginctl enable-linger youruser`.)

After a code update, reload the build with `sudo systemctl restart claude-broker`
— don't start a second daemon by hand.

## Configuration

The broker reads YAML from `~/.config/claude-broker/config.yaml`
(overridable with `--config`). See `config/default.yaml` for the
canonical example.

The `auth_token` field accepts `${ENV_VAR}` interpolation so the actual
secret can live in your environment or systemd unit instead of on disk.

## Logs

The broker uses `pino`. With `logging.pretty: true` it writes
human-readable lines; with `pretty: false` it writes structured JSON
(pipe through `jq` or your log shipper).

Rotation is the operator's responsibility — point your log file
somewhere logrotate can manage, or run with `--detach` (writes to
`/tmp/claude-broker.log`) and rotate that.

## State and backup

By default the SQLite database lives at
`~/.local/state/claude-broker/jobs.sqlite`. To back up:

```bash
sqlite3 ~/.local/state/claude-broker/jobs.sqlite ".backup '/path/to/backup.sqlite'"
```

The database is small (a single table) and online backups are safe.

## Health checks

`/healthz` (no auth) returns a JSON status payload. `/metrics` (no auth)
returns Prometheus exposition.

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `EADDRINUSE` on broker start | port already bound | kill the prior daemon (`daemon stop`) or change `broker.http.port` |
| `ENOENT` on `/tmp/claude-broker.sock` from shim | broker not running | start the broker first |
| Jobs sit in `pending` forever | no shim attached for that session | start the Claude session with the channels flag, check `/sessions` |
| Jobs land in `expired` | TTL too short | raise `broker.defaults.job_ttl_sec` or pass `ttl_sec` per job |
| Two brokers on same socket path | shouldn't happen — broker unlinks stale sockets on start | if it does: stop both, `rm /tmp/claude-broker.sock`, start one |
