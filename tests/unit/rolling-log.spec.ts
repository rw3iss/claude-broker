import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RollingLog, pruneLogsOlderThan } from '../../src/broker/rolling-log.js';

describe('RollingLog', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-roll-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const active = () => path.join(dir, 'jobs.log');
  const archives = () =>
    fs.readdirSync(dir).filter((f) => f !== 'jobs.log' && f.startsWith('jobs.'));

  it('appends lines and adds a trailing newline', () => {
    const log = new RollingLog({ dir, maxBytes: 1000 });
    log.append('hello');
    log.append('world\n');
    expect(fs.readFileSync(active(), 'utf8')).toBe('hello\nworld\n');
  });

  it('rolls to a timestamped archive when the active file exceeds maxBytes', () => {
    let t = 1000;
    const log = new RollingLog({ dir, maxBytes: 20, now: () => t++ });
    log.append('aaaaaaaa'); // 9 bytes
    log.append('bbbbbbbb'); // 18 bytes total — still under 20
    expect(archives()).toHaveLength(0);
    log.append('cccccccc'); // would be 27 — rolls first
    expect(archives()).toHaveLength(1);
    // Active file now holds only the latest line.
    expect(fs.readFileSync(active(), 'utf8')).toBe('cccccccc\n');
    // Archive holds the earlier lines.
    const arch = fs.readFileSync(path.join(dir, archives()[0]), 'utf8');
    expect(arch).toBe('aaaaaaaa\nbbbbbbbb\n');
  });

  it('keeps the active file name stable across multiple rolls', () => {
    let t = 5000;
    const log = new RollingLog({ dir, maxBytes: 12, now: () => t++ });
    for (let i = 0; i < 6; i++) log.append('xxxxxxxx'); // 9 bytes each
    expect(fs.existsSync(active())).toBe(true);
    expect(archives().length).toBeGreaterThanOrEqual(4);
  });

  it('continues from an existing active file size on reopen', () => {
    fs.writeFileSync(active(), 'x'.repeat(15) + '\n'); // 16 bytes
    const log = new RollingLog({ dir, maxBytes: 20, now: () => 9 });
    log.append('yyyy'); // 16 + 5 = 21 > 20 → rolls before writing
    expect(archives()).toHaveLength(1);
    expect(fs.readFileSync(active(), 'utf8')).toBe('yyyy\n');
  });

  it('disambiguates archives created at the same timestamp', () => {
    const log = new RollingLog({ dir, maxBytes: 12, now: () => 42 });
    log.append('aaaaaaaa');
    log.append('bbbbbbbb'); // roll #1 → jobs.42.log
    log.append('cccccccc'); // roll #2 → jobs.42-1.log
    const names = archives().sort();
    expect(names).toContain('jobs.42.log');
    expect(names).toContain('jobs.42-1.log');
  });
});

describe('pruneLogsOlderThan', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-prune-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('deletes files older than the cutoff and keeps newer ones', () => {
    const sess = path.join(root, 's1');
    fs.mkdirSync(sess, { recursive: true });
    const old = path.join(sess, 'jobs.100.log');
    const fresh = path.join(sess, 'jobs.log');
    fs.writeFileSync(old, 'old');
    fs.writeFileSync(fresh, 'new');
    // Backdate the archive well past the cutoff.
    fs.utimesSync(old, new Date(0), new Date(1_000));

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const deleted = pruneLogsOlderThan(root, cutoff);
    expect(deleted).toEqual([old]);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it('removes a session directory once it is emptied', () => {
    const sess = path.join(root, 's2');
    fs.mkdirSync(sess, { recursive: true });
    const f = path.join(sess, 'transcript-old.log');
    fs.writeFileSync(f, 'x');
    fs.utimesSync(f, new Date(0), new Date(1_000));

    pruneLogsOlderThan(root, Date.now());
    expect(fs.existsSync(sess)).toBe(false);
  });
});
