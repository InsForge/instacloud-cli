#!/usr/bin/env sh
# InstaCloud CLI installer. Downloads the prebuilt native binary for your platform from GitHub
# releases, verifies it against SHA256SUMS, and installs it. macOS / Linux / WSL.
#
#   curl -fsSL https://raw.githubusercontent.com/InsForge/instacloud-cli/main/install.sh | sh
#
# Agent one-liner (installs the CLI AND sets up coding-agent skills; on a human terminal it also
# offers the browser login — unattended runs stay fully non-interactive):
#   curl -fsSL https://raw.githubusercontent.com/InsForge/instacloud-cli/main/agents.sh | sh
#   (equivalent to piping this script with:  sh -s -- --agents; add -y for a hard non-interactive run)
#
# Flags:
#   --agents       after installing, run `insta setup agent` (skills for Claude Code/Codex/Cursor/…)
#   -y             non-interactive
#   --staging      target the staging deployment (shorthand for --env staging)
#   --env <name>   target a named deployment: prod (default) | staging
#
# Release channels:
#   prod (default)  the latest stable release
#   staging         the newest PRERELEASE (v*-rc.N etc), falling back to stable if none exists
#   Either way, INSTA_VERSION pins an exact tag and always wins.
#
# Options (env):
#   INSTA_VERSION      release tag to install (e.g. v0.1.0); default: the channel's newest
#   INSTA_INSTALL_DIR  install directory; default: $HOME/.insta/bin
#   INSTA_ENV          same as --env; the flag wins if both are given
#   INSTA_SKILLS_REPO  override the agent-skill source (default: per-environment, see src/env.ts)
set -eu

AGENTS=0
YES=0
# Environment is PERSISTED via `insta env use` below rather than exported, because the canonical
# install is a pipe and a piped script cannot set variables in the parent shell — an exported
# INSTA_ENV would vanish before the user's next `insta` command.
ENV_NAME="${INSTA_ENV:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --agents) AGENTS=1 ;;
    -y|--yes) YES=1 ;;
    --staging) ENV_NAME=staging ;;
    --env) shift; [ $# -gt 0 ] || { echo "error: --env needs a value (prod|staging)" >&2; exit 1; }; ENV_NAME="$1" ;;
    # `--env=` (empty) must be rejected like a bare `--env`, not silently treated as "no environment
    # requested" — otherwise a malformed selection falls through to the default instead of erroring.
    --env=) echo "error: --env needs a value (prod|staging)" >&2; exit 1 ;;
    --env=*) ENV_NAME="${1#--env=}" ;;
  esac
  shift
done

case "$ENV_NAME" in
  ''|prod|staging) ;;
  *) echo "error: unknown environment '$ENV_NAME' (expected prod or staging)" >&2; exit 1 ;;
esac

REPO="InsForge/instacloud-cli"
BIN="insta"
INSTALL_DIR="${INSTA_INSTALL_DIR:-$HOME/.insta/bin}"

command -v curl >/dev/null 2>&1 || { echo "error: curl is required" >&2; exit 1; }

# ---- release channel resolution ----
resolve_latest() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | sed -n 's/.*"tag_name": *"\(v[^"]*\)".*/\1/p' | head -1
}

# Newest PRERELEASE tag = the staging channel. /releases/latest deliberately excludes prereleases,
# so the list endpoint is the only way to find them. Within a release object GitHub emits tag_name
# before draft/prerelease, so we remember the tag and act when the flags arrive; a draft clears it
# (drafts have no downloadable assets).
# per_page=100 (the API maximum) rather than the default 30: with 30, once thirty newer stable
# releases pile up the newest prerelease slides onto page 2 and staging would silently install
# stable. 100 is a single request and covers any realistic release history; INSTA_VERSION remains
# the escape hatch beyond that.
resolve_prerelease() {
  curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=100" 2>/dev/null | awk '
    /"tag_name":/          { if (match($0, /v[^"]+/)) tag = substr($0, RSTART, RLENGTH) }
    /"draft": *true/       { tag = "" }
    /"prerelease": *true/  { if (tag != "") { print tag; exit } }'
}

# Staging tracks the prerelease channel so it can run a build that has not shipped to production.
# An explicit INSTA_VERSION always wins. If no prerelease exists yet, say so and fall back to
# stable rather than failing — staging is still perfectly usable on the released binary, since the
# environment split is about which control plane the CLI talks to.
if [ "$ENV_NAME" = "staging" ] && [ -z "${INSTA_VERSION:-}" ]; then
  pre_tag="$(resolve_prerelease || true)"
  if [ -n "$pre_tag" ]; then
    INSTA_VERSION="$pre_tag"
    echo "staging channel: prerelease $pre_tag"
  else
    echo "note: no prerelease published yet — installing the latest stable build (staging control plane either way)"
  fi
fi

# ---- already current? (skip the download; Railway-style existing-install awareness) ----
if [ -x "$INSTALL_DIR/$BIN" ] && [ -z "${INSTA_VERSION:-}" ]; then
  current="v$("$INSTALL_DIR/$BIN" --version 2>/dev/null | tail -1)"
  latest="$(resolve_latest || true)"
  if [ -n "$latest" ] && [ "$current" = "$latest" ]; then
    echo "✓ insta $latest already installed at $INSTALL_DIR/$BIN — up to date"
    SKIP_DOWNLOAD=1
  fi
fi
# other insta on PATH shadowing ours? (shells use the first hit)
first_hit="$(command -v insta 2>/dev/null || true)"
if [ -n "$first_hit" ] && [ "$first_hit" != "$INSTALL_DIR/$BIN" ]; then
  # Not a conflict if the first hit is just the symlink WE created into an on-PATH dir
  # (see the linking step below) — it resolves straight back to our binary. Warn only for a
  # genuinely different insta (e.g. an npm-installed one) that would actually shadow ours.
  if [ -L "$first_hit" ] && [ "$(readlink "$first_hit" 2>/dev/null)" = "$INSTALL_DIR/$BIN" ]; then
    : # our own symlink → the binary; nothing to warn about
  else
    echo "! another insta is first on your PATH: $first_hit"
    case "$first_hit" in
      */node_modules/*|*npm*|*/.nvm/*) echo "!   (npm-installed — update it with: npm update -g insta, or remove it to use the binary)" ;;
    esac
  fi
fi

# ---- detect platform ----
os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "error: unsupported OS '$os' (Windows: download insta-windows-x64.exe from the releases page)" >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64) arch="x64" ;;
  *) echo "error: unsupported architecture '$arch'" >&2; exit 1 ;;
esac
asset="insta-${os}-${arch}"

if [ "${SKIP_DOWNLOAD:-0}" = "1" ]; then
  :
else
# ---- resolve release URL ----
version="${INSTA_VERSION:-latest}"
if [ "$version" = "latest" ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$version"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --progress-bar (not -s): a silent download looks frozen. Show progress to a TTY; stay quiet
# when piped without one. Keep the tiny SHA256SUMS fetch silent.
if [ -t 2 ]; then dl="curl -fL --progress-bar"; else dl="curl -fsSL"; fi
# Prefer the gzipped asset (~3× smaller); fall back to the raw binary for older releases.
if curl -fsSL -I "$base/$asset.gz" >/dev/null 2>&1; then
  echo "Installing $BIN ($asset, $version) — downloading ~20MB…"
  $dl "$base/$asset.gz" -o "$tmp/$BIN.gz" || { echo "error: download failed ($base/$asset.gz)" >&2; exit 1; }
  gunzip "$tmp/$BIN.gz" || { echo "error: could not decompress $asset.gz" >&2; exit 1; }
else
  echo "Installing $BIN ($asset, $version) — downloading ~60MB…"
  $dl "$base/$asset" -o "$tmp/$BIN" || { echo "error: download failed ($base/$asset)" >&2; exit 1; }
fi
curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || { echo "error: could not fetch SHA256SUMS" >&2; exit 1; }

# ---- verify checksum ----
expected="$(grep " ${asset}\$" "$tmp/SHA256SUMS" | awk '{print $1}')"
[ -n "$expected" ] || { echo "error: no checksum for $asset in SHA256SUMS" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$BIN" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmp/$BIN" | awk '{print $1}')"
fi
if [ "$expected" != "$actual" ]; then
  echo "error: checksum mismatch for $asset" >&2
  echo "  expected $expected" >&2
  echo "  actual   $actual" >&2
  exit 1
fi

# ---- install ----
mkdir -p "$INSTALL_DIR"
chmod +x "$tmp/$BIN"
mv "$tmp/$BIN" "$INSTALL_DIR/$BIN"
echo "✓ installed to $INSTALL_DIR/$BIN"
"$INSTALL_DIR/$BIN" --version 2>/dev/null || true
fi

# ---- make `insta` immediately runnable in THIS shell ----
# The recommended one-liner is `curl … | sh && insta …`, so the binary must be callable in the
# current shell right away — a piped script can't edit the parent's PATH. If a directory that's
# already on PATH is writable (macOS /usr/local/bin, or ~/.local/bin), symlink there so `insta`
# just works with no profile reload. (This is why installing only to ~/.insta/bin fails.)
if [ "${SKIP_DOWNLOAD:-0}" != "1" ] || [ ! -e "$INSTALL_DIR/$BIN" ]; then :; fi
ON_PATH=0
case ":${PATH}:" in *":$INSTALL_DIR:"*) ON_PATH=1 ;; esac
LINKED=""
if [ "$ON_PATH" != "1" ]; then
  for d in /usr/local/bin "$HOME/.local/bin"; do
    case ":${PATH}:" in *":$d:"*) ;; *) continue ;; esac   # must already be on PATH
    [ -d "$d" ] && [ -w "$d" ] || continue                  # …and writable (no sudo)
    ln -sf "$INSTALL_DIR/$BIN" "$d/$BIN" && LINKED="$d/$BIN" && break
  done
fi

# ---- environment (--staging / --env) ----
# MUST run before `setup agent`: that step registers the MCP server, and it derives the MCP host and
# registration name from the persisted environment. Switching afterwards would leave the machine's
# agents pointed at production's MCP server while the CLI talked to staging.
if [ -n "$ENV_NAME" ]; then
  echo
  if ! "$INSTALL_DIR/$BIN" env use "$ENV_NAME"; then
    # HARD FAIL, deliberately. The environment was requested and could not be applied, so this
    # install is still pointed at PRODUCTION. Carrying on would be the worst outcome: the canonical
    # usage is `curl … | sh && insta project create`, often run unattended by an agent, which would
    # then provision real production infrastructure believing it was staging. Exiting here also
    # stops `setup agent` from wiring this machine's agents to the wrong environment.
    echo "error: could not select environment '$ENV_NAME' — this install is still pointed at PRODUCTION." >&2
    echo "  The installed CLI ($("$INSTALL_DIR/$BIN" --version 2>/dev/null | tail -1)) may predate \`insta env\` (needs >= 0.0.23)." >&2
    echo "  Upgrade, then retry:  insta upgrade && insta env use $ENV_NAME" >&2
    exit 1
  fi
  ENV_APPLIED=1
fi

# ---- agent setup (--agents) ----
if [ "$AGENTS" = "1" ]; then
  echo
  # `insta setup agent` prints its own "setting up coding-agent skills …" line + clean summary.
  # CLI >= 0.0.38: bare `setup agent` FORCES prod (switching the machine if needed), so a staging
  # install must pass the environment explicitly. The persisted env already matches (env use above),
  # so --env is a no-op switch there — it just stops setup from "correcting" the machine to prod.
  # Older CLIs (a pinned INSTA_VERSION) reject the flag; ONLY that exact case (commander's
  # "unknown option", which exits before doing anything) falls back to the bare form — on those
  # versions it follows the persisted environment, the old, correct semantics. Any other failure
  # must NOT retry bare: on >= 0.0.38 the bare form would flip a requested staging setup to prod.
  SETUP_ENV_ARGS=""
  [ -n "$ENV_NAME" ] && SETUP_ENV_ARGS="--env $ENV_NAME"
  # -y is a HARD non-interactive request, exactly as the help text says — it is never dropped.
  # agents.sh no longer forwards it: without -y the CLI itself decides promptability (a human
  # terminal answers via /dev/tty, CLI >= 0.0.44; agents/CI/cron are never prompted), so the
  # curl|sh path can offer the browser login while unattended runs stay fully non-interactive.
  YFLAG=""
  [ "$YES" = "1" ] && YFLAG="-y"
  SETUP_ERR="${TMPDIR:-/tmp}/insta-setup-err.$$"
  if "$INSTALL_DIR/$BIN" setup agent $YFLAG $SETUP_ENV_ARGS 2>"$SETUP_ERR"; then
    cat "$SETUP_ERR" >&2
  else
    cat "$SETUP_ERR" >&2
    if [ -n "$SETUP_ENV_ARGS" ] && grep -qi "unknown option" "$SETUP_ERR"; then
      "$INSTALL_DIR/$BIN" setup agent $YFLAG || echo "warn: agent setup failed — run: insta setup agent"
    else
      echo "warn: agent setup failed — run: insta setup agent ${SETUP_ENV_ARGS}"
    fi
  fi
  rm -f "$SETUP_ERR"
fi

# ---- PATH: confirm reachable, or tell the user exactly how (incl. THIS shell) ----
if [ "$ON_PATH" = "1" ]; then
  : # already on PATH
elif [ -n "$LINKED" ]; then
  echo "✓ linked → $LINKED (on your PATH)"
  command -v hash >/dev/null 2>&1 && hash -r 2>/dev/null || true  # drop any cached 'not found'
else
  # No writable PATH dir — persist for new shells, and make THIS shell work now.
  for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    [ -e "$rc" ] || continue
    grep -q "$INSTALL_DIR" "$rc" 2>/dev/null || printf '\nexport PATH="%s:$PATH"\n' "$INSTALL_DIR" >> "$rc"
  done
  echo
  echo "Added $BIN to your PATH for new shells. For THIS shell, run:"
  echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
  echo "(the recommended \`… | sh && insta …\` one-liner needs \`insta\` on PATH — the line above enables it here)"
fi


# ---- next steps (the 3-command wow: real infra, then a full isolated clone of it) ----
echo
# Only claim persistence when `env use` actually succeeded (it exits above if not, so this is
# belt-and-braces against the banner ever outliving the step it describes).
if [ "$ENV_NAME" = "staging" ] && [ "${ENV_APPLIED:-0}" = "1" ]; then
  echo "Environment: staging (api.staging.instacloud.com) — persisted; \`insta env use prod\` to switch back."
  echo
fi
echo "Next steps:"
echo "  insta login                    # connect to the cloud (or run insta-oss locally to skip)"
echo "  insta project create demo      # postgres + storage + compute, provisioned in one shot"
# Whether a directory deploy needs a Dockerfile depends on the target: optional on insta-compute
# (nixpacks builds it server-side), still required on Fly. The banner does not promise either.
echo "  insta build .                  # check what would ship (Dockerfile, start command, port)"
echo "  insta deploy . --port 3000     # ship your app and get a live URL"
echo "  insta branch create preview    # clone db + storage + app into an isolated env"
echo
echo "Your coding agents now know InstaCloud — you can just ask them to do the above."
