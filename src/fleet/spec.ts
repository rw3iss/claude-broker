/**
 * The fleet spec: which managed Claude sessions the broker keeps running.
 * Persisted as JSON (default ~/.config/claude-broker/fleet.json). Pure
 * planning helpers live here (tests/unit/fleet-spec.spec.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const MAX_POOL_SESSIONS = 16;
export const LABEL_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const zEffort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

export const FleetPoolSchema = z.object({
  name: z.string().regex(LABEL_RE, 'letters, digits, - _ . only (≤ 64)'),
  count: z.number().int().min(1).max(MAX_POOL_SESSIONS).default(1),
  /** Claude model alias or id for this pool's sessions (e.g. "haiku"). */
  model: z.string().min(1).max(100).optional(),
  effort: zEffort.optional(),
});

export const FleetSpecSchema = z
  .object({
    pools: z.array(FleetPoolSchema).max(64).default([]),
    /** Working directory for every session (neutral, NOT a repo). Default: the fleet state dir's workdir. */
    cwd: z.string().min(1).optional(),
    model: z.string().min(1).max(100).optional(),
    effort: zEffort.optional(),
    /** Start the fleet when the daemon starts. */
    autostart: z.boolean().default(true),
    /** Nudge an idle managed session whose job sits undelivered. */
    nudge: z.boolean().default(true),
  })
  .superRefine((spec, ctx) => {
    const labels = new Set<string>();
    for (const [i, p] of spec.pools.entries()) {
      for (const l of labelsFor(p)) {
        if (labels.has(l)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pools', i, 'name'], message: `duplicate session label "${l}"` });
        }
        labels.add(l);
      }
    }
    if (spec.cwd && !path.isAbsolute(spec.cwd)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cwd'], message: 'cwd must be an absolute path' });
    }
  });

export type FleetPool = z.infer<typeof FleetPoolSchema>;
export type FleetSpec = z.infer<typeof FleetSpecSchema>;

export const EMPTY_SPEC: FleetSpec = { pools: [], autostart: true, nudge: true };

/** A pool's session labels: `name` (count 1) or `name-1` … `name-N`. */
export function labelsFor(pool: { name: string; count?: number }): string[] {
  const n = Math.max(1, Math.min(MAX_POOL_SESSIONS, pool.count ?? 1));
  if (n === 1) return [pool.name];
  return Array.from({ length: n }, (_, i) => `${pool.name}-${i + 1}`);
}

export interface DesiredSession {
  label: string;
  pool: string;
  model?: string;
  effort?: FleetSpec['effort'];
}

export function desiredSessions(spec: FleetSpec): DesiredSession[] {
  const out: DesiredSession[] = [];
  for (const p of spec.pools) {
    for (const label of labelsFor(p)) {
      out.push({ label, pool: p.name, model: p.model ?? spec.model, effort: p.effort ?? spec.effort });
    }
  }
  return out;
}

export interface FleetPlan {
  start: string[];
  stop: string[];
  keep: string[];
}

/** Windows to start / stop / keep, given the desired labels and the window names that exist. */
export function planFleet(desired: string[], existing: string[], reserved: ReadonlySet<string>): FleetPlan {
  const want = new Set(desired);
  const have = new Set(existing.filter((w) => !reserved.has(w)));
  return {
    start: desired.filter((l) => !have.has(l)),
    stop: [...have].filter((w) => !want.has(w)),
    keep: desired.filter((l) => have.has(l)),
  };
}

export function loadSpec(file: string): FleetSpec {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const parsed = FleetSpecSchema.safeParse(raw);
    return parsed.success ? parsed.data : { ...EMPTY_SPEC };
  } catch {
    return { ...EMPTY_SPEC };
  }
}

/** Write a file atomically (temp + rename) with the given mode. */
export function writeFileAtomic(file: string, content: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
}

export function saveSpec(file: string, spec: FleetSpec): void {
  writeFileAtomic(file, JSON.stringify(spec, null, 2) + '\n');
}
