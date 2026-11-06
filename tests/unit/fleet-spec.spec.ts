import { describe, expect, it } from 'vitest';
import { desiredSessions, FleetSpecSchema, labelsFor, planFleet } from '../../src/fleet/spec.js';

describe('fleet spec', () => {
  it('labels: name for count 1, name-1..N otherwise', () => {
    expect(labelsFor({ name: 'general', count: 1 })).toEqual(['general']);
    expect(labelsFor({ name: 'summary', count: 3 })).toEqual(['summary-1', 'summary-2', 'summary-3']);
  });

  it('pool model/effort override the spec defaults', () => {
    const spec = FleetSpecSchema.parse({ model: 'haiku', effort: 'low', pools: [{ name: 'a', count: 1 }, { name: 'b', count: 2, model: 'sonnet' }] });
    expect(desiredSessions(spec)).toEqual([
      { label: 'a', pool: 'a', model: 'haiku', effort: 'low' },
      { label: 'b-1', pool: 'b', model: 'sonnet', effort: 'low' },
      { label: 'b-2', pool: 'b', model: 'sonnet', effort: 'low' },
    ]);
  });

  it('defaults autostart + nudge on', () => {
    expect(FleetSpecSchema.parse({})).toMatchObject({ pools: [], autostart: true, nudge: true });
  });

  it('rejects bad names, counts, relative cwd and duplicate labels', () => {
    expect(FleetSpecSchema.safeParse({ pools: [{ name: 'bad name' }] }).success).toBe(false);
    expect(FleetSpecSchema.safeParse({ pools: [{ name: 'a', count: 17 }] }).success).toBe(false);
    expect(FleetSpecSchema.safeParse({ cwd: 'relative/dir' }).success).toBe(false);
    // "a-1" (pool a-1, count 1) collides with pool a's first member.
    expect(FleetSpecSchema.safeParse({ pools: [{ name: 'a', count: 2 }, { name: 'a-1' }] }).success).toBe(false);
  });

  it('plans start / stop / keep, never touching reserved windows', () => {
    const plan = planFleet(['a', 'b-1', 'b-2'], ['_idle', '_auth', 'a', 'old'], new Set(['_idle', '_auth']));
    expect(plan).toEqual({ start: ['b-1', 'b-2'], stop: ['old'], keep: ['a'] });
  });
});
