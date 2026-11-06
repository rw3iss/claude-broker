# Architecture

This document is a condensed reference for contributors. The original
design conversation lives in `docs/plans/2026-05-27-claude-channel-broker.md`
(when present); this file is the abridged, in-repo version.

## Two processes

```
HTTP clients ──▶ Broker daemon (long-lived) ──── unix socket ───▶ Shim ◀── stdio ─▶ Claude Code session
```

- **Broker** owns: HTTP server, unix-socket server, job store, session
  registry, dispatcher, SSE bus, sweeper.
- **Shim** owns: an MCP `Server` over stdio for one Claude session, plus
  a unix-socket client to the broker. It is a stateless pump.

The broker is the source of truth. The shim has no persistence and no
business logic — every Claude tool call is forwarded to the broker
untouched.

## Job lifecycle

```
pending ──▶ dispatched ──▶ in_progress ──▶ completed
                                       └▶ failed
                                       └▶ cancelled
        └▶ expired (TTL elapsed)
        └▶ orphaned (session unreachable past grace)
```

Transitions are made atomic by `JobStore.transitionStatus(id, from, to,
patch)` — implementations must return null when the row's current
status doesn't match `expectedFrom`.

## Wire protocol (broker ↔ shim)

Line-delimited JSON on a unix socket. Every message has `{ v, type, … }`
where `v` is the protocol version (currently `1`). See
`src/broker/wire.ts` for the full message catalog.

Shim → broker: `register`, `reconnect`, `heartbeat`, `toolCall`.
Broker → shim: `registered`, `dispatch`, `cancel`, `comment`,
`toolResult`, `shutdown`, `error`.

## Ports & adapters

`src/ports/*.ts` defines the abstract interfaces:

- `JobStore` (CRUD + atomic status transitions + expiry queries)
- `JobDispatcher` (per-session serial / fire-and-forget orchestration)
- `SessionStore` (optional audit log)
- `Clock`, `Logger`

`src/adapters/*` implements them. `src/lib/container.ts` is the
composition root — the **only** place that wires a concrete adapter
to a service.

Adding a new backend means writing one file under `src/adapters/<kind>/`
and adding a switch case in the container. See
[adapters.md](./adapters.md) for the playbook.

## SOLID accountability

| Principle | Mechanism |
|---|---|
| Single responsibility | One file per box: `JobService` doesn't speak HTTP, `HttpServer` doesn't touch the DB. |
| Open/closed | Adapters extend behavior. Adding Postgres means one file under `src/adapters/job-store/`, zero edits to `JobService`. |
| Liskov | Every adapter satisfies its port — contract tests in `tests/adapters/contract/` enforce this. |
| Interface segregation | `JobStore` is CRUD; pub/sub is an optional `subscribe?` method, so adapters that can't notify still satisfy the port. |
| Dependency inversion | Services import ports; only `src/lib/container.ts` wires adapters. |

## Fleet, health and routing (0.6)

- **`src/fleet/tui-state.ts`** — pure classifier of a session's pane text →
  `TuiState` (+ the deciding line) and the first-run dialog answers. Tested
  against captured panes in `tests/fixtures/panes/`.
- **`src/fleet/routing.ts`** — `pickSession`: least-busy HEALTHY attached
  candidate (ties → least recently routed); `inPool`. `JobService.route()`
  uses it for `session_label` and `pool`.
- **`src/broker/tui-watcher.ts`** — every `broker.tui.check_interval_sec`
  classifies unmanaged sessions (pid → tmux pane, read-only) and nudges idle
  sessions whose job sits `dispatched` (managed by default, unmanaged opt-in).
- **`src/fleet/tmux.ts`** — the PRIVATE tmux server (`-L`, TMUX stripped, no
  kill-server). **`src/fleet/spec.ts`** — spec schema, labels, `planFleet`.
  **`src/fleet/launch.ts`** — per-session MCP config + settings (0600), the
  window command, pre-trust, shim path. **`src/fleet/fleet-manager.ts`** —
  apply / stop / restart + the supervisor tick (dialogs, respawn + backoff,
  wedge → /clear → respawn, login → respawn after a new token).
  **`src/fleet/auth.ts`** — `claude setup-token` in a tmux window → URL → code
  → token saved to the 0600 env file (never logged).
- `SessionHandle` gains `tuiState`, `tuiDetail`, `tuiCheckedAt`, `managed`,
  `lastDispatchAt`.

## File map

```
src/ports/             interfaces, no impls
src/adapters/          concrete impls (sqlite, inproc, real clock, pino, …)
src/broker/            HTTP server, socket server, services, registry, sweeper
src/shim/              MCP server + broker client
src/cli/               commander entrypoints
src/lib/               config, container, ids, errors, migrate
src/fleet/             0.6: managed sessions, Claude sign-in, TUI classifier, routing
migrations/            SQL schema, append-only
config/                shipped default.yaml + zod schema
```

## Testing strategy

- **Unit** — `tests/unit/`, pure logic with mocked ports.
- **Contract** — `tests/adapters/contract/`, parameterized; every new
  adapter passes the same suite.
- **Integration** — `tests/integration/`, boots one subsystem (HTTP
  server, socket server, full broker) with real deps and exercises it.
- **E2E** — `tests/e2e/full-loop.spec.ts` drives a `MockClaude` through
  submit → dispatch → complete and runs in under a second.

No `setTimeout`-based waits in unit tests. Use the `Clock` port and
advance the fake clock instead.
