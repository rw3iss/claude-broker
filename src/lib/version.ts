import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

/**
 * The installed package version, read from package.json. Probes the layouts
 * the binary runs from (dist build, source tree). Cached after first read.
 */
export function packageVersion(): string {
  if (cached) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', 'package.json'), // src/lib → repo root
    path.resolve(here, '..', '..', '..', 'package.json'), // dist/src/lib → root
    path.resolve(here, '..', '..', '..', '..', 'package.json'),
  ];
  for (const c of candidates) {
    try {
      const v = JSON.parse(fs.readFileSync(c, 'utf8')).version;
      if (typeof v === 'string' && v.length > 0) {
        cached = v;
        return v;
      }
    } catch {
      /* try next */
    }
  }
  cached = '0.0.0';
  return cached;
}
