/**
 * Every test runs with a throwaway HOME, so nothing a test builds (fleet spec,
 * oauth.env, state dirs, ~/.claude.json pre-trust) can touch — or be started
 * from — the developer's real configuration.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccb-home-'));
process.env.HOME = home;
process.env.CLAUDE_BROKER_TUI_ENABLED = 'false';
delete process.env.CLAUDE_CONFIG_DIR;
