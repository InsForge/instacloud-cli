#!/usr/bin/env sh
#
# InstaCloud agent setup installer, STAGING — the one-liner for coding agents:
#
#     curl -fsSL agents.staging.instacloud.com | sh
#
# (agents.staging.instacloud.com is a CloudFront edge cache of this file, the staging sibling of
#  agents.instacloud.com → agents.sh. The raw fallback also works:
#  curl -fsSL https://raw.githubusercontent.com/InsForge/instacloud-cli/main/agents-staging.sh | sh)
#
# Identical to agents.sh except that everything it installs points at staging:
#
#   CLI      the newest PRERELEASE build (v*-rc.N), falling back to the latest stable if none
#            exists yet. INSTA_VERSION pins an exact tag and overrides this.
#   API      api.staging.instacloud.com   (us-west-1, a separate deployment from prod)
#   MCP      mcp.staging.instacloud.com, registered as `insta-cloud-staging` so it can coexist
#            with a production registration on the same machine
#   skills   the staging ref of InsForge/instacloud-skills, so the agent reads skill text that
#            describes the staging control plane
#
# One command, and every piece is staging. This script itself ships from `main` (same as
# agents.sh) — it is the installer, not the thing being staged.
#
# --staging is passed to install.sh (rather than exporting INSTA_ENV around it) so the choice is
# PERSISTED into ~/.insta/config.json. A piped `curl … | sh` cannot export into the parent shell,
# so an env var would evaporate before the `insta project create` the user runs next.
set -eu

# Download to a file and check curl's status BEFORE running it, rather than piping straight into sh.
# A piped `curl … | sh` that fails to fetch hands sh an EMPTY stream, and sh exits 0 — so the
# one-liner reports success while installing nothing. That matters most for automation, which has
# only the exit code to go on.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
if ! curl -fsSL https://raw.githubusercontent.com/InsForge/instacloud-cli/main/install.sh -o "$tmp"; then
  echo "error: could not download install.sh (network, or GitHub raw unavailable)" >&2
  exit 1
fi
[ -s "$tmp" ] || { echo "error: downloaded install.sh is empty" >&2; exit 1; }
# No -y: without it the CLI decides promptability itself (a human terminal answers the login
# offer via /dev/tty; unattended runs are never prompted). Pass -y for a hard non-interactive run.
sh "$tmp" --agents --staging "$@"
