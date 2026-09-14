# Contributing to insta

Thanks for taking the time. Issues and pull requests are both welcome.

## Dev loop

```bash
npm install
npm test                       # vitest; tests use injected fakes, no docker or network
npm run typecheck              # tsc --noEmit
npx tsx src/index.ts --help    # run the CLI from source
npm run build                  # -> dist/index.js (pure JS, needs node to run)
```

Run `npm run typecheck && npm test` before every commit.

`insta project create` and `insta project link` have side effects in the working directory
(`.insta/`, the observe hook, agent skills). Exercise them in a scratch directory.

## Architecture

Node 18 or newer, TypeScript compiled to ESM, [commander](https://github.com/tj/commander.js)
for the command surface. Every command wraps one control-plane API call.

| Path | Responsibility |
|---|---|
| `src/index.ts` | The commander program; registers every command |
| `src/api.ts` | Typed control-plane client: auth headers, token refresh, error mapping |
| `src/config.ts` | Global `~/.insta/config.json` and project `./.insta/project.json` |
| `src/env.ts` | The `prod` / `staging` environment table and its resolution rules |
| `src/commands/` | One file per command group |
| `src/observe/` | The local credential-audit hook: scanner, hook, install, report |
| `src/flyctl-build.ts` | Source-directory deploy: Fly build context |
| `src/ensure-skills.ts` | Installs and refreshes agent skills in the user's project |

Two conventions worth knowing before you write code:

- Side-effectful modules take injected runners or fetch implementations so they can be
  tested without mocking globals. See `ensure-skills.ts`, `commands/setup.ts` and
  `test/deploy-port.test.ts`.
- **A command or flag change is only half done until it is mirrored in the agent-facing
  command reference**, [`insta/cli-reference.md`](https://github.com/InsForge/instacloud-skills/blob/main/insta/cli-reference.md)
  in `InsForge/instacloud-skills`. That file is how coding agents learn the CLI surface, and this
  repo's README links to it rather than duplicating it. Update it in the same change set.

## Pull requests

`main` is protected. Branch from `origin/main` using a `feat/*`, `fix/*` or `docs/*` prefix
and open a PR against `main`; merges are squashed. The `ci` workflow runs the gate on both
platforms — `test` (ubuntu-latest) and `test-windows` (windows-latest), each running typecheck
plus the full vitest suite — and `cubic` is an AI reviewer whose comments are not the required
approval. Both `ci` jobs are expected green before merge; a Windows-only failure is a real
failure (the CLI shells out to npm/npx shims that behave differently there). A PR needs one
approving review, and you cannot approve your own.

Maintainers: the internal review and release runbook is in
`.claude/skills/developing-insta-cli/SKILL.md`.

## Building binaries

The binaries that `install.sh` serves are cross-compiled with [Bun](https://bun.sh) by CI
and published to GitHub releases. The npm package ships JavaScript (`dist/index.js`);
binaries are a separate distribution channel.

```bash
npm run compile          # current platform only -> dist/bin/insta
npm run build:binaries   # all platforms -> dist/bin/insta-<os>-<arch>[.exe] + SHA256SUMS
```

Artifacts are named `insta-darwin-arm64`, `insta-linux-x64`, `insta-windows-x64.exe` and so
on, and are real native executables. The version baked into `insta --version` comes from
`package.json`, or pass one explicitly: `bash scripts/build-binaries.sh 1.2.3`. `dist/` is
gitignored; binaries are never committed.

## Releasing

1. Open a PR that bumps the version in `package.json` and merge it. `main` is protected, so
   the bump cannot be committed directly.
2. Tag the merge commit and push the tag:
   ```bash
   git checkout main && git pull
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
3. The `release` workflow builds five platform binaries plus `SHA256SUMS` and publishes a
   GitHub Release. `install.sh`, `agents.sh` and `insta upgrade` serve it immediately.
4. The same workflow publishes to npm over OIDC trusted publishing, so no token secret
   exists in the repo. Verify with `npm view insta version`.

Prereleases (`vX.Y.Z-rc.N`) publish with `--prerelease` on GitHub and under npm's `next`
tag. That is what keeps the staging channel from reaching production installers, so do not
publish a prerelease to `latest`.

## Running against a local control plane

The CLI talks to whatever `INSTA_API_URL` points at, and that variable outranks the
persisted config, so a local control plane gives you an end-to-end loop without touching
cloud infrastructure.

The platform has a `dev:fake` mode that swaps in fake provider adapters, so it needs no
Fly or Tigris credentials (nor Neon's — Neon is no longer used by any environment; its
adapter code is retained, not live):

```bash
# 1. Postgres for the control plane itself
docker run -d --name pg \
  -e POSTGRES_PASSWORD=insta -e POSTGRES_DB=insta_dev -p 55432:5432 postgres:16-alpine

# 2. The platform dev server (separate repository)
DATABASE_URL='postgres://postgres:insta@localhost:55432/insta_dev' PORT=8899 npm run dev:fake

# 3. Point the CLI at it
INSTA_API_URL=http://localhost:8899 npx tsx src/index.ts login --email you@example.com
```

Signup goes through `/auth/signup` and `/auth/verify-email`. In dev mode the verification
code is printed to the server log rather than emailed.

`insta-oss` runs the same API surface as a local daemon and works the same way. Both it and
the platform live in separate repositories.

## The onboarding domain

`agents.instacloud.com` is a CloudFront distribution that edge-caches `agents.sh` from this
repository's `main` branch. After changing `agents.sh`, the edge can serve the previous copy
for up to about 24 hours unless the distribution is invalidated.
