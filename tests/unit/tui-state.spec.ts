import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyPane,
  detectDialog,
  dialogKey,
  isHealthyTuiState,
  selectedOption,
} from '../../src/fleet/tui-state.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'panes');
const pane = (name: string): string => fs.readFileSync(path.join(dir, `${name}.txt`), 'utf8');

describe('classifyPane (captured panes)', () => {
  it.each([
    ['usage-limited', 'usage_limited'],
    ['channels-unavailable', 'channels_unavailable'],
    ['login-expired', 'login_required'],
    ['context-wedged', 'context_wedged'],
    ['dev-channels-first', 'prompt'],
    ['bypass', 'prompt'],
    ['ready', 'ready'],
    ['working', 'working'],
  ])('%s → %s', (fixture, state) => {
    expect(classifyPane(pane(fixture)).state).toBe(state);
  });

  it('reports the deciding line', () => {
    expect(classifyPane(pane('channels-unavailable')).detail).toContain('ignored (server:claude-broker)');
    expect(classifyPane(pane('login-expired')).detail).toContain('Login expired');
  });

  it('an empty pane is starting; a bare banner is starting', () => {
    expect(classifyPane('').state).toBe('starting');
    expect(classifyPane('Claude Code v2.1.311\n').state).toBe('starting');
  });

  it('health: only the failure states are unhealthy; unknown is healthy', () => {
    expect(isHealthyTuiState('ready')).toBe(true);
    expect(isHealthyTuiState('working')).toBe(true);
    expect(isHealthyTuiState('unknown')).toBe(true);
    expect(isHealthyTuiState(undefined)).toBe(true);
    for (const s of ['usage_limited', 'login_required', 'context_wedged', 'channels_unavailable', 'exited'] as const) {
      expect(isHealthyTuiState(s)).toBe(false);
    }
  });
});

describe('first-run dialogs', () => {
  it('dev channels: Enter when "local development" is selected, else Down', () => {
    const a = pane('dev-channels-first');
    const b = pane('dev-channels-second');
    const dialog = detectDialog(a)!;
    expect(dialog.name).toBe('dev-channels');
    expect(dialogKey(a, dialog)).toBe('Enter');
    expect(dialogKey(b, detectDialog(b)!)).toBe('Down');
  });

  it('bypass permissions: moves to "Yes, I accept"', () => {
    const p = pane('bypass');
    expect(detectDialog(p)?.name).toBe('bypass');
    expect(selectedOption(p)).toContain('No, exit');
    expect(dialogKey(p, detectDialog(p)!)).toBe('Down');
  });

  it('the usage-limit menu is not a dialog the fleet answers', () => {
    expect(detectDialog(pane('usage-limited'))).toBeNull();
  });
});
