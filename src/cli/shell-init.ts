import { Command } from 'commander';

/**
 * Emits a shell function that launches a Claude Code session on the
 * claude-broker channel while capturing the full terminal transcript to a
 * per-session log file — staying fully interactive (it runs Claude inside a
 * pty via `script`, so the TUI is unaffected and you still see it live).
 *
 * Install:  eval "$(claude-broker shell-init)"   # in ~/.zshrc or ~/.bashrc
 * Use:      cll [label]                           # label defaults to "default"
 */
export function shellInitCommand(): Command {
  return new Command('shell-init')
    .description('Print a shell function (default: cll) that launches + logs a Claude session')
    .option('--name <fn>', 'name of the emitted shell function', 'cll')
    .action((opts: { name: string }) => {
      process.stdout.write(renderShellFunction(opts.name));
    });
}

export function renderShellFunction(fn: string): string {
  return `# claude-broker launcher — add to your shell profile with:
#   eval "$(claude-broker shell-init)"
# Then:  ${fn} [label]      (label defaults to "default")
${fn}() {
  local label="\${1:-default}"
  local root="\${CLAUDE_BROKER_LOG_DIR:-$HOME/.local/state/claude-broker/logs}"
  local dir="$root/$label"
  mkdir -p "$dir" || return 1
  local ts file cmd
  ts="$(date +%Y%m%d-%H%M%S)"
  file="$dir/transcript-$ts.log"
  cmd="claude --dangerously-skip-permissions --dangerously-load-development-channels server:claude-broker"
  printf 'claude-broker: session %s\\n  transcript: %s\\n  watch:      claude-broker logs %s --transcript -f\\n  job log:    claude-broker logs %s -f\\n' "$label" "$file" "$label" "$label"
  # Run Claude inside a pty so the TUI stays interactive while everything is
  # captured to the transcript file. Session id/label are pinned to the log
  # label so the daemon's job log lands in the same <dir>.
  if script --version >/dev/null 2>&1; then
    # util-linux script
    CLAUDE_BROKER_SESSION_ID="$label" CLAUDE_BROKER_SESSION_LABEL="$label" \\
      script -q -e -f -c "$cmd" "$file"
  else
    # BSD/macOS script
    CLAUDE_BROKER_SESSION_ID="$label" CLAUDE_BROKER_SESSION_LABEL="$label" \\
      script -q "$file" $cmd
  fi
}
`;
}
