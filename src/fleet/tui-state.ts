/**
 * Classify what a Claude Code session's terminal is showing — pure, so it is
 * tested against captured pane fixtures (tests/unit/tui-state.spec.ts).
 *
 * WHY: a session can be ATTACHED (its MCP shim connected) and still unable to
 * do any work — usage limit menu, expired login, wedged context, or a channel
 * Claude Code refused. Jobs routed to it just expire. The broker reads the
 * pane so routing can skip such sessions and operators can see why.
 */

export type TuiState =
  | 'unknown'
  | 'starting'
  | 'prompt'
  | 'ready'
  | 'working'
  | 'usage_limited'
  | 'login_required'
  | 'context_wedged'
  | 'channels_unavailable'
  | 'exited';

/** States in which the session cannot do work: routing skips them. */
export const UNHEALTHY_TUI_STATES: ReadonlySet<TuiState> = new Set<TuiState>([
  'usage_limited',
  'login_required',
  'context_wedged',
  'channels_unavailable',
  'exited',
]);

export function isHealthyTuiState(state: TuiState | undefined | null): boolean {
  return !state || !UNHEALTHY_TUI_STATES.has(state);
}

export interface TuiClassification {
  state: TuiState;
  /** The line that decided it (trimmed), when there is one. */
  detail: string | null;
}

interface Rule {
  state: TuiState;
  re: RegExp;
}

// Order matters: the first rule that matches wins. Hard failures first, then
// dialogs, then activity.
const RULES: Rule[] = [
  {
    state: 'channels_unavailable',
    re: /Channels are not (currently )?available|Channels are not enabled for your org|ignored \(server:claude-broker\)/i,
  },
  {
    state: 'login_required',
    re: /Login expired|Please run \/login|OAuth token (has )?expired|Invalid API key|Not logged in/i,
  },
  {
    state: 'usage_limited',
    re: /limit to reset|usage limit reached|You've (reached|hit) your (usage |session |weekly |5-hour )?limit|Claude AI usage limit|Add funds to continue/i,
  },
  { state: 'context_wedged', re: /Context limit reached/i },
  {
    state: 'prompt',
    re: /Do you trust|trust the files|trust this folder|Bypass Permissions mode|Loading development channels|development channels|Choose the text style|Press Enter to continue|Select (a )?theme/i,
  },
  { state: 'working', re: /esc to interrupt|\(esc to cancel\)/i },
];

/** Strip ANSI/OSC escapes (captures are normally plain, but be safe). */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Z0-9]/g, '');
}

/** Classify the visible pane text (from `tmux capture-pane -p`). */
export function classifyPane(raw: string): TuiClassification {
  const text = stripAnsi(raw ?? '');
  if (!text.trim()) return { state: 'starting', detail: null };
  const lines = text.split('\n');
  for (const rule of RULES) {
    const line = lines.find((l) => rule.re.test(l));
    if (line !== undefined) return { state: rule.state, detail: line.replace(/^[\s▎│|]+/, '').trim().slice(0, 300) };
    // Multi-line patterns (e.g. "limit to reset" split by a wrap) — test the whole text too.
    if (rule.re.test(text.replace(/\n/g, ' '))) return { state: rule.state, detail: null };
  }
  // Idle input prompt: a "❯ " line inside the input box, no dialog above.
  if (lines.some((l) => /^\s*[│|]?\s*❯\s/.test(l) || /^\s*❯\s*$/.test(l))) return { state: 'ready', detail: null };
  if (/Claude Code v\d/i.test(text)) return { state: 'starting', detail: null };
  return { state: 'unknown', detail: null };
}

/** A first-run dialog the fleet answers by itself. */
export interface DialogAnswer {
  name: string;
  /** Option line to select (the one marked ❯ must match before Enter). */
  choose: RegExp | null;
}

const DIALOGS: Array<{ when: RegExp; answer: DialogAnswer }> = [
  { when: /Do you trust|trust the files|trust this folder/i, answer: { name: 'trust', choose: /Yes/i } },
  { when: /Bypass Permissions mode/i, answer: { name: 'bypass', choose: /Yes, I accept/i } },
  { when: /development channels/i, answer: { name: 'dev-channels', choose: /local development/i } },
  { when: /Choose the text style|Select (a )?theme/i, answer: { name: 'theme', choose: null } },
  { when: /Press Enter to continue/i, answer: { name: 'continue', choose: null } },
];

/** Which known dialog the pane shows, if any. */
export function detectDialog(raw: string): DialogAnswer | null {
  const text = stripAnsi(raw ?? '');
  const hit = DIALOGS.find((d) => d.when.test(text));
  return hit ? hit.answer : null;
}

/** The currently selected option line of a numbered menu ("❯ 2. …"). */
export function selectedOption(raw: string): string | null {
  const line = stripAnsi(raw ?? '').split('\n').find((l) => /❯\s*\d+\./.test(l));
  return line ? line.trim() : null;
}

/**
 * The keystroke that moves a dialog toward its answer: `Enter` when the
 * wanted option is selected (or the dialog has no choice), else `Down`.
 */
export function dialogKey(raw: string, answer: DialogAnswer): 'Enter' | 'Down' {
  if (!answer.choose) return 'Enter';
  const sel = selectedOption(raw);
  if (sel === null) return 'Enter';
  return answer.choose.test(sel) ? 'Enter' : 'Down';
}
