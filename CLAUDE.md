# CLAUDE.md — claude-broker

## What this repo is

A daemon that bridges Claude Code sessions and any local HTTP client via
the Claude Code "channels" MCP protocol. Two processes:

- **broker** (long-lived): HTTP API + job queue + state.
- **shim** (one per Claude session): spawned by Claude Code, talks MCP
  on stdio, talks JSON to the broker on a unix socket.

## Conventions

- **TypeScript strict.** `noImplicitAny`, `strictNullChecks`, no `any`
  except at boundary parsers (and only with a zod parse following).
- **Ports under `src/ports/`, implementations under `src/adapters/`.**
  Services depend on ports, never on adapters. `src/lib/container.ts`
  is the only place that wires concrete adapters to ports.
- **No singletons.** Every dependency is constructor-injected. The
  container is the composition root.
- **Errors are typed.** `src/lib/errors.ts` defines `NotFoundError`,
  `ConflictError`, `ValidationError`. HTTP layer maps to status codes
  in one place.
- **Time is a port.** Use `Clock.now()`, not `Date.now()`. Use fake
  clock in tests.
- **Logging is a port.** Use `Logger.info(...)`, not console.log.
- **Migrations are append-only.** Never edit a migration that has been
  applied to anything outside a fresh dev box.
- **No new top-level dependencies without justification.** Keep the
  install lean.

## Architectural rules

- **The broker is the source of truth.** Shims are stateless pumps.
- **The wire protocol is versioned.** Bump `v:` on every breaking
  change to the broker ↔ shim or HTTP API.
- **Adapters must pass the contract tests** in
  `tests/adapters/contract/`. New adapter → one new line of test setup.
- **Instructions to Claude are configuration**, not code. They live in
  `config/default.yaml`.

## Commands

- `pnpm dev` — runs broker in foreground with file watch.
- `pnpm test` — full test suite.
- `pnpm test:watch` — vitest watch.
- `pnpm typecheck` — `tsc --noEmit`.
- `pnpm build` — tsc to `dist/`.

## When working on this repo

- New endpoints: add schema in `src/broker/schemas.ts`, route in
  `src/broker/http-server.ts`, integration test in
  `tests/integration/http.spec.ts`.
- New tool the shim exposes: add the name to `ToolName` + a schema to
  `DEFAULT_TOOLS` in `src/broker/tools.ts`, add a handler to `TOOL_HANDLERS`
  in `src/broker/tool-router.ts` (the `Record<ToolName, …>` type enforces
  parity), update the default instructions text in `config/default.yaml`,
  document in README "Tools" section.
- New adapter: file under `src/adapters/<kind>/<name>.ts`, register
  in `src/lib/container.ts`, add to the contract test parameterization,
  document in `docs/adapters.md`.
- Session logging (off by default): `src/broker/session-logger.ts` (SseBus
  subscriber → structured job I/O) and `src/broker/rolling-log.ts` (size
  rotation) write under the dir from `src/lib/log-paths.ts`
  (`resolveLogDir`: `CLAUDE_BROKER_LOG_DIR` → config → default). The
  `claude-broker logs` reader (`src/cli/logs.ts`) and the `cll` launcher
  (`src/cli/shell-init.ts`) resolve the same dir. The daemon sees only job
  in/out, never Claude's transcript — that's the `cll`/`script` layer.

## What to read first

1. README.md (user-facing overview)
2. docs/architecture.md (the design, condensed)
3. src/ports/types.ts (the vocabulary)
4. src/broker/job-service.ts (the orchestration center)
