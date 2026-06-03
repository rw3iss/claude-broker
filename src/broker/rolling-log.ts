import fs from 'node:fs';
import path from 'node:path';

export interface RollingLogOptions {
  /** Directory the log lives in (created on demand). */
  dir: string;
  /** Active file name. Defaults to `jobs.log`. */
  baseName?: string;
  /** Roll to an archive once the active file would exceed this many bytes. */
  maxBytes: number;
  /** Injectable clock for deterministic archive names in tests. */
  now?: () => number;
}

/**
 * Append-only log with size-based rotation.
 *
 * The active file name is **stable** (`jobs.log`): when it would exceed
 * `maxBytes`, it is renamed to a timestamped archive (`jobs.<ms>.log`) and a
 * fresh `jobs.log` is started. This keeps the current file small while
 * preserving history, rolls in O(1) (one rename — no whole-file rewrite), and
 * lets `tail -F jobs.log` follow across rotations seamlessly.
 *
 * Writes are synchronous `appendFileSync` calls — job volume is human-paced,
 * and sync keeps line ordering simple and crash-safe without an fd to leak.
 */
export class RollingLog {
  private readonly dir: string;
  private readonly baseName: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly activePath: string;
  /** Bytes in the active file; -1 until lazily initialized from disk. */
  private bytes = -1;

  constructor(opts: RollingLogOptions) {
    this.dir = opts.dir;
    this.baseName = opts.baseName ?? 'jobs.log';
    this.maxBytes = opts.maxBytes;
    this.now = opts.now ?? Date.now;
    this.activePath = path.join(this.dir, this.baseName);
  }

  /** Append one record. A trailing newline is added if missing. */
  append(line: string): void {
    const text = line.endsWith('\n') ? line : line + '\n';
    fs.mkdirSync(this.dir, { recursive: true });

    if (this.bytes < 0) {
      this.bytes = fs.existsSync(this.activePath)
        ? fs.statSync(this.activePath).size
        : 0;
    }

    const len = Buffer.byteLength(text);
    if (this.bytes > 0 && this.bytes + len > this.maxBytes) {
      this.roll();
    }

    fs.appendFileSync(this.activePath, text);
    this.bytes += len;
  }

  private roll(): void {
    const { name, ext } = parseName(this.baseName);
    let stamp = this.now();
    let archive = path.join(this.dir, `${name}.${stamp}${ext}`);
    let n = 0;
    while (fs.existsSync(archive)) {
      archive = path.join(this.dir, `${name}.${stamp}-${++n}${ext}`);
    }
    fs.renameSync(this.activePath, archive);
    this.bytes = 0;
  }
}

function parseName(baseName: string): { name: string; ext: string } {
  const ext = path.extname(baseName); // ".log"
  const name = baseName.slice(0, baseName.length - ext.length);
  return { name, ext };
}

/**
 * Delete log files under `root` (recursively) whose mtime is older than
 * `cutoffMs`. Returns the deleted paths. Empty session directories left
 * behind are removed too. Used by the sweeper (auto-retention) and by
 * `claude-broker logs clear --days-before`.
 */
export function pruneLogsOlderThan(root: string, cutoffMs: number): string[] {
  if (!fs.existsSync(root)) return [];
  const deleted: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      deleted.push(...pruneLogsOlderThan(full, cutoffMs));
      // Drop the directory if it's now empty.
      try {
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
      } catch {
        /* ignore */
      }
    } else if (entry.isFile()) {
      try {
        if (fs.statSync(full).mtimeMs < cutoffMs) {
          fs.unlinkSync(full);
          deleted.push(full);
        }
      } catch {
        /* ignore */
      }
    }
  }
  return deleted;
}
