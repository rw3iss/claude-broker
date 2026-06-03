# How it works

Three legs, three different protocols. This document traces one job
end-to-end so you know where to look when something goes wrong.

```
┌─────────────────┐  HTTP/JSON   ┌────────────────┐  unix socket  ┌────────────┐  MCP/stdio  ┌─────────────┐
│ CLI / curl / SDK│ ───────────▶ │ broker (daemon)│ ────────────▶ │   shim     │ ──────────▶ │ Claude Code │
│  any HTTP client│  Bearer auth │ src/broker/    │  line-JSON v1 │ src/shim/  │  channel    │   session   │
└─────────────────┘              └────────────────┘               └────────────┘             └─────────────┘
```

Each leg is independently swappable: HTTP doesn't know about the socket,
the socket doesn't know about MCP, the shim doesn't know about SQLite.

## 1. CLI → daemon (HTTP/JSON)

The CLI is a thin HTTP client. `claude-broker jobs submit ...` builds a JSON
body and POSTs it to `http://127.0.0.1:4180/jobs`.

- `src/cli/jobs.ts` calls `httpJson(client, 'POST', '/jobs', body)`.
- `src/cli/client.ts:httpJson` is a plain `fetch()` with
  `Authorization: Bearer ${config.broker.http.auth_token}`.

On the daemon side, `src/broker/http-server.ts`:

```ts
fastify.post('/jobs', async (req, reply) => {
  await requireAuth(req);
  const body = SubmitJobBodySchema.parse(req.body);
  const job = await opts.service.submit(body);   // → JobService
  return { job_id: job.id, status: job.status, job: serializeJob(job) };
});
```

The CLI has no privileged access — it uses the same `/jobs` endpoint
anything else would. `JobService.submit` (`src/broker/job-service.ts`)
inserts the job into the SQLite `JobStore` and calls
`dispatcher.notifyPending(sessionId, jobId)`.

## 2. daemon ↔ shim (unix socket, line-delimited JSON)

The unix socket lives at `/tmp/claude-broker.sock`. Each accepted
connection is one shim, and one shim is one Claude session. Every message
is **one JSON object per `\n`-terminated line**, with a version byte and a
`type` discriminator:

```json
{ "v": 1, "type": "dispatch", "jobId": "abc12345", "content": "...", "meta": {} }
```

The full catalog is in `src/broker/wire.ts`:

| Direction | `type` | Payload |
|---|---|---|
| shim → broker | `register` | `{ sessionId, label?, pid?, version? }` |
| shim → broker | `heartbeat` | sent every 10s |
| shim → broker | `reconnect` | `{ sessionId, inFlightJobIds }` |
| shim → broker | `toolCall` | `{ id, name, args }` |
| broker → shim | `registered` | `{ sessionId, instructionsToInject? }` |
| broker → shim | `dispatch` | `{ jobId, content, meta }` |
| broker → shim | `cancel` | follow-up: submitter cancelled |
| broker → shim | `comment` | follow-up: submitter added context |
| broker → shim | `toolResult` | `{ id, result?, error? }` |
| broker → shim | `shutdown` | broker is going down cleanly |

Every message includes `v: 1`. v2 messages will be rejected with an
`error` reply so future protocol bumps fail loud rather than silent.

The broker is the dispatch sink. `src/adapters/job-dispatcher/inproc.ts:
drainOnce` picks the next pending job for a session, atomically transitions
`pending → dispatched` in the `JobStore`, and asks
`SocketServer.send(sessionId, msg)` to write the line. `SocketServer`
(`src/broker/socket-server.ts`) keeps a `sessionId → connection` map so it
knows which fd to write to.

The shim side (`src/shim/broker-client.ts`) is a small reconnecting
client:

- Buffers outbound tool calls if disconnected (default 100 messages).
- Awaits `toolResult` by correlation id (`id` field on `toolCall`).
- Emits `heartbeat` every 10s; the broker evicts sessions whose last
  heartbeat is older than `heartbeat_timeout_sec`.

## 3. shim ↔ Claude (MCP over stdio)

Claude Code spawned the shim with stdin/stdout wired to itself. The shim
builds an MCP `Server` with the `claude/channel` experimental capability
(`src/shim/mcp-server.ts`):

```ts
const server = new Server(info, {
  capabilities: {
    tools: {},
    experimental: { 'claude/channel': {} },   // makes Claude treat this as a channel
  },
  instructions: opts.instructions,            // appended to Claude's system prompt
});
```

Two flows:

**Push (broker → Claude)**. On receiving `dispatch`, the shim calls:

```ts
server.notification({
  method: 'notifications/claude/channel',
  params: { content, meta: { ...meta, job_id: jobId } },
});
```

Claude Code intercepts that notification and injects a
`<channel source="claude-broker" job_id="...">...</channel>` tag into the
model's next turn.

**Reply (Claude → broker)**. When Claude calls a tool like `complete_job`,
MCP sends a `tools/call` request to the shim. `src/shim/mcp-server.ts`
registers a `CallToolRequestSchema` handler that forwards every call back
over the unix socket as a `toolCall`, and awaits the matching `toolResult`.

`SocketServer.handleToolCall` (`src/broker/socket-server.ts`) hands the call
to `dispatchTool` (`src/broker/tool-router.ts`), whose `Record<ToolName, …>`
handler map translates it into a `JobService` method (`complete`, `fail`,
`noteProgress`, `ack`), which transitions the job in the DB and publishes
on the SSE bus. The tool schemas the shim advertises live in
`src/broker/tools.ts`, so the schema list and the routing share one
`ToolName` source of truth.

## End-to-end: `claude-broker jobs submit --session-label trader --wait`

1. CLI → `POST /jobs` → daemon.
2. `JobService.submit` → `JobStore.insert` → `dispatcher.notifyPending`.
3. Dispatcher transitions `pending → dispatched`, writes one line of JSON
   to the shim's socket fd.
4. Shim parses the line, calls `server.notification(...)` over stdio.
5. Claude Code injects a `<channel>` tag into the model's context.
6. Claude does the work, calls `complete_job({job_id, result})` via MCP.
7. Shim forwards as `toolCall` over the socket; awaits `toolResult`.
8. `JobService.complete` updates the DB to `completed`, publishes
   `job.completed` on the SSE bus.
9. The CLI's `--wait` was long-polling `GET /jobs/:id/wait` — that handler
   is subscribed to the SSE bus and returns the final job JSON.

## Where to look when something breaks

| Symptom | Layer | Where to start |
|---|---|---|
| HTTP 401 / 404 from CLI | leg 1 | `src/broker/http-server.ts`, check token + body schema |
| Job stuck in `pending` | leg 2 | `claude-broker sessions list` — no shim attached for that session |
| Job stuck in `dispatched`, never `completed` | leg 3 | Claude didn't call `complete_job`. Check that the shim is injecting `instructions` into MCP init (see `src/shim/load-instructions.ts`) |
| Second job blocked behind a stuck first | dispatcher | Default mode is `serial`. Submit with `--mode fire-and-forget` if you don't need ordering |
| Shim repeatedly reconnects | leg 2 | Broker socket path mismatch, or the broker isn't running. `ls /tmp/claude-broker.sock` |
| `version_mismatch` error in shim log | leg 2 | A v2 client hit a v1 broker (or vice versa). Bump or downgrade one side |

## Session logging — what each layer can see

A recurring question: can the daemon log the whole Claude conversation? No —
and the leg model above is why. The broker only ever sees what crosses leg 2:
the **job in** (`content` + `meta`, captured at `job.created`) and the **job
out** (`result`/`error`/progress, captured when Claude calls the reply tools).
Claude's reasoning, its `Read`/`Bash` tool use, and what it prints to its own
terminal never reach the broker — those live entirely inside leg 3.

So there are two logs, both off by default:

| Log | Written by | Source | Contents |
|---|---|---|---|
| `<dir>/<session>/jobs.log` | daemon (`SessionLogger`) | SseBus job events | structured JSONL: input + output + progress |
| `<dir>/<session>/transcript-<ts>.log` | `cll` launcher | `script` pty capture | the full interactive terminal session |

`SessionLogger` (`src/broker/session-logger.ts`) is just another SseBus
subscriber — the same bus the long-poll and `/stream` handlers use — so it
adds no coupling to the job path. Writes go through `RollingLog`
(`src/broker/rolling-log.ts`): a stable active `jobs.log` plus timestamped
archives, so size stays bounded and `tail -F` (what `claude-broker logs -f`
runs) follows across rotations. See the README "Session logging" section for
the commands.

## Related docs

- [architecture.md](./architecture.md) — module boundaries and SOLID accountability.
- [adapters.md](./adapters.md) — how to add a Postgres or BullMQ backend.
- [operations.md](./operations.md) — running the broker under systemd, log rotation, backup.
