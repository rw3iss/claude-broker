#!/usr/bin/env bash
#
# claude-broker installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/rw3iss/claude-broker/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/rw3iss/claude-broker/main/install.sh | bash -s -- --update
#
# Flags:
#   --update           Pull the latest source in an existing install and rebuild.
#   --shell-init       Add the `cll` launcher to your shell rc (.bashrc/.zshrc).
#   --prefix DIR       Override install prefix (default: ~/.local/share/claude-broker).
#   --bin-dir DIR      Override bin symlink dir (default: ~/.local/bin).
#   --ref REF          Git ref to check out (branch / tag / SHA). Default: main.
#   --repo URL         Override source git URL.
#   -h, --help         Show this help.

set -euo pipefail

REPO_URL_DEFAULT="https://github.com/rw3iss/claude-broker.git"
PREFIX_DEFAULT="${HOME}/.local/share/claude-broker"
BIN_DIR_DEFAULT="${HOME}/.local/bin"
REF_DEFAULT="main"

UPDATE=0
SHELL_INIT=0
PREFIX="${CLAUDE_BROKER_PREFIX:-$PREFIX_DEFAULT}"
BIN_DIR="${CLAUDE_BROKER_BIN_DIR:-$BIN_DIR_DEFAULT}"
REF="${CLAUDE_BROKER_REF:-$REF_DEFAULT}"
REPO_URL="${CLAUDE_BROKER_REPO:-$REPO_URL_DEFAULT}"

usage() {
  awk '/^#!/{next} /^[^#]/{exit} {sub(/^# ?/, ""); print}' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --update) UPDATE=1; shift ;;
    --shell-init) SHELL_INIT=1; shift ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --ref) REF="$2"; shift 2 ;;
    --repo) REPO_URL="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

# Resolve the interactive shell's rc file for the cll launcher. New terminals
# are non-login shells, so the eval must live in .bashrc / .zshrc (NOT
# .bash_profile, which only login shells read).
shell_rc() {
  case "$(basename "${SHELL:-/bin/bash}")" in
    zsh)  echo "$HOME/.zshrc" ;;
    bash) echo "$HOME/.bashrc" ;;
    *)    echo "" ;;
  esac
}

CLL_LINE='eval "$(claude-broker shell-init)"'

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

need git
need node

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  die "node 20+ required (found $(node -v 2>/dev/null || echo none))"
fi

PKG_MGR=""
if command -v pnpm >/dev/null 2>&1; then
  PKG_MGR="pnpm"
elif command -v npm >/dev/null 2>&1; then
  PKG_MGR="npm"
else
  die "neither pnpm nor npm found on PATH"
fi

mkdir -p "$(dirname "$PREFIX")" "$BIN_DIR"

if [ -d "$PREFIX/.git" ]; then
  if [ "$UPDATE" -eq 1 ]; then
    log "updating $PREFIX (ref: $REF)"
    git -C "$PREFIX" fetch --tags --prune origin
    git -C "$PREFIX" checkout "$REF"
    # If on a branch, fast-forward; for detached tags/SHAs this is a no-op.
    if git -C "$PREFIX" symbolic-ref -q HEAD >/dev/null; then
      git -C "$PREFIX" pull --ff-only origin "$REF"
    fi
  else
    die "$PREFIX already exists. Re-run with --update to refresh, or pass --prefix to install elsewhere."
  fi
else
  if [ "$UPDATE" -eq 1 ]; then
    die "--update passed but no existing install at $PREFIX"
  fi
  log "cloning $REPO_URL → $PREFIX"
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$PREFIX" 2>/dev/null \
    || git clone "$REPO_URL" "$PREFIX"
  if [ "$REF" != "main" ]; then
    git -C "$PREFIX" checkout "$REF"
  fi
fi

log "installing dependencies with $PKG_MGR"
case "$PKG_MGR" in
  pnpm) ( cd "$PREFIX" && pnpm install --prod=false --frozen-lockfile 2>/dev/null \
            || pnpm install --prod=false ) ;;
  npm)  ( cd "$PREFIX" && npm install --no-audit --no-fund ) ;;
esac

# pnpm 10's approved-builds gate makes `pnpm rebuild` a silent no-op on
# fresh installs. Locate the better-sqlite3 dir and compile the binding
# directly with node-gyp — that's what actually produces build/Release/*.node.
log "compiling native modules (better-sqlite3)"
BSQLITE_DIR=""
if [ -d "$PREFIX/node_modules/better-sqlite3" ]; then
  BSQLITE_DIR="$PREFIX/node_modules/better-sqlite3"
else
  BSQLITE_DIR="$(find "$PREFIX/node_modules" -maxdepth 5 -type d -name 'better-sqlite3' -path '*/node_modules/better-sqlite3' 2>/dev/null | head -n1)"
fi
if [ -z "$BSQLITE_DIR" ] || [ ! -f "$BSQLITE_DIR/binding.gyp" ]; then
  warn "could not find better-sqlite3 directory under $PREFIX/node_modules — daemon may not start"
else
  if command -v node-gyp >/dev/null 2>&1; then
    ( cd "$BSQLITE_DIR" && node-gyp rebuild ) || \
      warn "node-gyp rebuild failed — install python3, make, g++ then re-run --update"
  else
    # Fall back to package manager rebuild; may be a no-op on pnpm 10+
    case "$PKG_MGR" in
      pnpm) ( cd "$PREFIX" && pnpm rebuild better-sqlite3 ) ;;
      npm)  ( cd "$PREFIX" && npm rebuild better-sqlite3 ) ;;
    esac
    if [ ! -f "$BSQLITE_DIR/build/Release/better_sqlite3.node" ]; then
      warn "native binding missing after rebuild; install node-gyp (npm i -g node-gyp) then re-run --update"
    fi
  fi
fi

log "building"
( cd "$PREFIX" && $PKG_MGR run build )

LINK_TARGET="$PREFIX/bin/claude-broker"
LINK_PATH="$BIN_DIR/claude-broker"
[ -x "$LINK_TARGET" ] || chmod +x "$LINK_TARGET" 2>/dev/null || true

if [ -L "$LINK_PATH" ] || [ -e "$LINK_PATH" ]; then
  rm -f "$LINK_PATH"
fi
ln -s "$LINK_TARGET" "$LINK_PATH"
log "symlinked $LINK_PATH → $LINK_TARGET"

INSTALLED_VERSION="$(node -p "require('$PREFIX/package.json').version" 2>/dev/null || echo unknown)"

case ":$PATH:" in
  *":$BIN_DIR:"*) ON_PATH=1 ;;
  *) ON_PATH=0 ;;
esac

ACTION="installed"
[ "$UPDATE" -eq 1 ] && ACTION="updated"

cat <<EOF

  claude-broker v${INSTALLED_VERSION} ${ACTION}.

  Source:    $PREFIX
  Binary:    $LINK_PATH

EOF

if [ "$ON_PATH" -eq 0 ]; then
  cat <<EOF
  $BIN_DIR is not on your PATH. Add this to your shell profile:

    export PATH="$BIN_DIR:\$PATH"

EOF
fi

if [ "$UPDATE" -eq 1 ]; then
  cat <<'EOF'
  If the daemon is running, restart it to pick up the new build:
    claude-broker daemon stop && claude-broker daemon start --detach

EOF
else
  cat <<'EOF'
  Next steps:
    1. claude-broker daemon start
    2. Add this to ~/.claude.json (or your project .mcp.json):
         {"mcpServers":{"claude-broker":{"command":"claude-broker","args":["shim"]}}}
    3. Launch Claude Code with:
         claude --dangerously-load-development-channels server:claude-broker

  Update later with:
    claude-broker update

EOF
fi

# cll launcher (start + log a Claude session in one command). New terminals are
# non-login shells that read .bashrc/.zshrc — so the eval goes THERE, never in
# .bash_profile (login-only). --shell-init wires it automatically.
RC="$(shell_rc)"
if [ "$SHELL_INIT" -eq 1 ]; then
  if [ -z "$RC" ]; then
    warn "couldn't detect your shell rc; add manually:  $CLL_LINE"
  elif grep -qF 'claude-broker shell-init' "$RC" 2>/dev/null; then
    log "cll launcher already enabled in $RC"
  else
    printf '\n# claude-broker cll launcher\n%s\n' "$CLL_LINE" >> "$RC"
    log "enabled the cll launcher in $RC — restart your shell or: source $RC"
  fi
elif [ -n "$RC" ] && grep -qF 'claude-broker shell-init' "$RC" 2>/dev/null; then
  : # already enabled — stay quiet
else
  cat <<EOF
  Optional — enable the 'cll' launcher (start + log a Claude session):
    echo '$CLL_LINE' >> ${RC:-~/.bashrc}
    # then restart your shell. Use ~/.bashrc or ~/.zshrc — NOT ~/.bash_profile
    # (login-only). Or re-run the installer with --shell-init to do it for you.

EOF
fi
