/**
 * Session selection for label and pool routing — pure (tested in
 * tests/unit/routing.spec.ts).
 *
 * Before 0.6 `findByLabel` returned the FIRST attached session, so several
 * sessions sharing a label never load-balanced and a sick session kept
 * receiving jobs. Now: among the attached, HEALTHY candidates pick the one
 * with the fewest active jobs; ties go to the least recently dispatched.
 */
import { isHealthyTuiState, type TuiState } from './tui-state.js';

export interface RoutingCandidate {
  id: string;
  label: string | null;
  status: string;
  tuiState?: TuiState | null;
  lastDispatchAt?: number | null;
}

/** Labels belonging to a pool: `<pool>` or `<pool>-<n>`. */
export function inPool(label: string | null | undefined, pool: string): boolean {
  if (!label) return false;
  if (label === pool) return true;
  if (!label.startsWith(`${pool}-`)) return false;
  return /^\d+$/.test(label.slice(pool.length + 1));
}

/** The pool a label belongs to (`summary-2` → `summary`). */
export function poolOfLabel(label: string): string {
  const m = /^(.*)-(\d+)$/.exec(label);
  return m && m[1] ? m[1] : label;
}

/**
 * Pick the best candidate. `busy` = active (pending/dispatched/in_progress)
 * jobs per session id. Returns null when no attached healthy candidate exists.
 */
export function pickSession<T extends RoutingCandidate>(
  candidates: T[],
  busy: Map<string, number>,
): T | null {
  const ok = candidates.filter((c) => c.status === 'attached' && isHealthyTuiState(c.tuiState ?? null));
  if (!ok.length) return null;
  return [...ok].sort((a, b) => {
    const d = (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0);
    if (d !== 0) return d;
    return (a.lastDispatchAt ?? 0) - (b.lastDispatchAt ?? 0);
  })[0] ?? null;
}
