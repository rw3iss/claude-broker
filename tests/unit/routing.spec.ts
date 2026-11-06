import { describe, expect, it } from 'vitest';
import { inPool, pickSession, poolOfLabel } from '../../src/fleet/routing.js';

const c = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, status: 'attached', ...extra });

describe('pool membership', () => {
  it('matches <pool> and <pool>-<n> only', () => {
    expect(inPool('summary', 'summary')).toBe(true);
    expect(inPool('summary-12', 'summary')).toBe(true);
    expect(inPool('summary-x', 'summary')).toBe(false);
    expect(inPool('summary2', 'summary')).toBe(false);
    expect(inPool(null, 'summary')).toBe(false);
  });

  it('poolOfLabel strips a numeric suffix', () => {
    expect(poolOfLabel('summary-3')).toBe('summary');
    expect(poolOfLabel('general')).toBe('general');
    expect(poolOfLabel('a-b-2')).toBe('a-b');
  });
});

describe('pickSession', () => {
  it('picks the least busy', () => {
    const busy = new Map([['a', 2], ['b', 0], ['c', 1]]);
    expect(pickSession([c('a'), c('b'), c('c')], busy)?.id).toBe('b');
  });

  it('breaks ties by least recently dispatched', () => {
    const busy = new Map<string, number>();
    expect(pickSession([c('a', { lastDispatchAt: 50 }), c('b', { lastDispatchAt: 10 })], busy)?.id).toBe('b');
  });

  it('skips unhealthy and detached sessions', () => {
    const busy = new Map([['ok', 5]]);
    const got = pickSession(
      [c('lim', { tuiState: 'usage_limited' }), c('gone', { status: 'detached' }), c('ok')],
      busy,
    );
    expect(got?.id).toBe('ok');
  });

  it('returns null when no healthy session is attached', () => {
    expect(pickSession([c('x', { tuiState: 'login_required' })], new Map())).toBeNull();
  });
});
