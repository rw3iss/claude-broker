# Changelog

## 0.6.0 — 2026-11-05

Robustness release, from running long-lived worker pools (CivicGate) in production.

- **Pools + health-aware routing**: `POST /jobs` accepts `pool` (members `<pool>` / `<pool>-<n>`); label and pool
  routing pick the least-busy HEALTHY attached session (was: the first attached session for a label). `GET /pools`.
- **TUI watcher**: each attached session's pane is classified (`ready`, `working`, `prompt`, `starting`,
  `usage_limited`, `login_required`, `context_wedged`, `channels_unavailable`, `exited`, `unknown`);
  `GET /sessions` items carry `tui_state`, `tui_detail`, `tui_checked_at`, `busy`, `managed`.
- **Nudge**: an idle session whose job sits `dispatched` > 20 s is nudged (managed sessions by default).
- **Fleet (managed sessions)**: `GET/PUT /fleet`, `POST /fleet/apply|stop`, `POST /fleet/sessions/:label/restart`;
  private tmux server, per-session MCP config + settings, pre-trusted neutral cwd, `ENABLE_TOOL_SEARCH=false`,
  dialogs auto-answered, respawn with backoff, wedge → /clear → respawn, autostart.
- **Claude sign-in**: `GET /auth`, `POST /auth/login`, `POST /auth/login/code`, `DELETE /auth/login|token` —
  `claude setup-token` driven in a tmux window; long-lived token in a 0600 env file sourced by every managed window.
- `/healthz` → `capabilities`. CLI: `fleet`, `auth`, `pools`, `jobs submit --pool`.
- Backward compatible: every 0.5 endpoint, field and CLI command is unchanged.
