---
name: developing-insta-cli
description: Use when working in the insta-cli repo — changing code, adding commands, opening PRs, getting them approved, or shipping a release (binaries and npm). Covers the review flow, the tag-triggered release workflow, and the manual npm publish.
---

# Developing & shipping insta-cli

## Dev loop

```bash
npm install
npm test              # vitest — all tests in test/, DI fakes (no docker/network needed)
npm run typecheck     # tsc --noEmit
npx tsx src/index.ts --help   # run the CLI from source
```

- One command per file in `src/commands/`, registered in `src/index.ts` (commander).
- Side-effectful modules take injected runners/fetch for tests (see `ensure-skills.ts`, `commands/setup.ts`, `test/deploy-port.test.ts`) — follow that pattern; don't mock globals.
- `project create|link` has side effects in cwd (`.insta/`, observe hook, agent skills) — exercise them only in scratch dirs.
- End-to-end without the cloud: run the insta-oss daemon and point the CLI at it with `INSTA_API_URL` (env wins over persisted config since v0.0.7).

## Architecture (`src/`)

| Path | Responsibility |
|------|----------------|
| `index.ts` | commander program — registers every command |
| `api.ts` | typed platform-API client (auth headers, token refresh, error mapping) |
| `config.ts` | global `~/.insta/config.json` (apiUrl + tokens + user) · project `./.insta/project.json` (projectId / orgId / current branch) · machine-local `./.insta/link-plane.json` (the control plane the link was made on; a foreign link fails closed in `requireProject`) |
| `commands/` | one file per command group: `auth` `org` `project` `services` `branch` `secrets` `build` `deploy` `compute` `upgrade` `metrics` (+`logs`) `billing` `govern` (policy/approvals) `manifest` `observe` |
| `observe/` | local `insta observe` hook — `scanner.ts` (AWS/GitHub/Stripe/LLM/DB cred detection), `hook.ts`, `install.ts`, `report.ts` (→ platform event ingest) |
| `flyctl-build.ts` | source-directory deploy build glue (Fly build context) |
| `nixpacks.ts` | nixpacks glue for `insta build` — plan detection + Dockerfile generation (no Docker daemon) |
| `ensure-skills.ts` | installs/refreshes the agent skills into the user's project |
| `util.ts` | shared helpers |

- **Command/flag changes must be mirrored in `skills/insta/cli-reference.md`** (the superproject
  `skills/` submodule) — that reference doc is how agents learn the CLI surface, so a new or
  renamed command/flag is only half-done until it's updated there, in the same change set.

## Getting a PR merged (main is protected — this exact flow, no other works)

1. Branch from `origin/main`: `feat/*` or `fix/*`. PRs target `main`. **Squash merge.**
2. Checks expected green: the `ci` workflow's **two** jobs — `test` (ubuntu-latest) and `test-windows` (windows-latest), each typecheck + vitest — and `cubic` (AI review — it comments; a comment is NOT the required approval). Windows runs the same suite, so a win-only failure is real: the CLI spawns npm/npx `.cmd` shims that POSIX never exercises. Note branch protection currently pins only the 1-approval rule — no status check is GitHub-*required*, so a red job will not block the merge button for you.
3. **Branch protection requires 1 approving review, and you cannot approve your own PR.** Team flow: post in the `#insforge-approval-bot` Slack channel asking John-bot to approve, **one PR link per message** — multi-link messages get partially processed. Approval lands as a GitHub review from the maintainer bot within ~2 min.
4. Arm `gh pr merge --auto --squash` while checks run; if the PR sat long enough to conflict, merge `origin/main` into your branch, resolve, re-push (approval survives unless dismissed).

## Shipping a release (two halves — the second is manual)

1. **Bump**: PR changing `package.json` version (main is protected — never commit the bump directly). Merge it via the flow above.
2. **Tag**: `git checkout main && git pull && git tag vX.Y.Z && git push origin vX.Y.Z`.
3. **Binaries (automatic)**: the `release` workflow builds 5 platform binaries + SHA256SUMS and publishes a GitHub Release. `install.sh`, `agents.sh`, and `insta upgrade` serve users from it immediately.
4. **npm (automatic on tag — OIDC trusted publishing)**: the `publish-npm` job authenticates via
   OpenID Connect (npmjs.com → `insta` → Trusted Publisher = this repo's `release.yml`); no token
   secret exists. If npm ever rejects the OIDC exchange, or for an out-of-band publish, the manual
   fallback — from a clean checkout at the tag, repo root:
   ```bash
   npm publish --otp=<2FA code>   # prepublishOnly builds dist/; EOTP error = missing/expired code
   ```
   Verify either path with `npm view insta version`.
5. Users on the binary channel update via `insta upgrade`; npm users via `npx insta@latest` / `npm update -g insta`.

## Gotchas

| Symptom | Cause / fix |
|---|---|
| PR green but unmergeable, `REVIEW_REQUIRED` | You can't self-approve — John-bot flow above |
| John-bot ignored the request | Batched links — resend ONE link per message |
| `npm error code EOTP` | Publish needs `--otp=<fresh 2FA code>` |
| `npm publish` ENOENT package.json | Ran outside the repo root |
| `npx insta@latest` behind the GH release | `publish-npm` job failed (OIDC trust/config?) — see step 4 |
| `'C:\Program' is not recognized` from a spawned tool (win CI only) | `resolveSpawnable`'s cmd.exe hop strips the quotes around a spaced executable path (`C:\Program Files\…`). It exists for npm-installed `.cmd` shims — a real `.exe` (git, …) must be spawned directly, which finds it through PATHEXT anyway |
| CLI hits the wrong server in tests | Persisted `~/.insta/config.json` apiUrl; set `INSTA_API_URL` (≥0.0.7) or move the config aside |

## agents.instacloud.com

The onboarding domain is a CloudFront distribution edge-caching `agents.sh` from this repo's
main branch (origin `raw.githubusercontent.com`, path rewrite → `/agents.sh`). After editing
`agents.sh`, the edge can serve the old copy for up to ~24h — invalidate it:
`aws cloudfront create-invalidation --distribution-id <the agents distro> --paths '/*'`.

## Keep this skill true

Before you finish work in this repo: if anything you did or discovered changed the flows above —
new required checks, a different review path, release steps added/automated (e.g. npm publish
moving into CI), new command conventions — update this SKILL.md **in the same PR** as the change.
A stale process skill is worse than none: the next agent will confidently follow it.
