# insta-cli

[![npm](https://img.shields.io/npm/v/insta?color=blue)](https://www.npmjs.com/package/insta)
[![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg)](LICENSE)

The InstaCloud CLI. Provision Postgres, object storage and compute, fork the whole
environment per branch, and give your coding agent scoped credentials without pasting
secrets into a chat window.

`insta` is a thin client over the InstaCloud control-plane API. Every command is one API
call, so anything you can do, an agent can do.

## Install

Native binary, no Node required (macOS / Linux / WSL). Installs to `~/.insta/bin` and
verifies the download against `SHA256SUMS`:

```bash
curl -fsSL https://raw.githubusercontent.com/InsForge/instacloud-cli/main/install.sh | sh
```

From npm:

```bash
npm install -g insta
```

For coding agents. Installs the CLI, the `insta` skill for every agent on the machine, and
registers the MCP server — one command for macOS, Linux, WSL, and native Windows shells
(PowerShell/cmd). Needs Node 18+ with a writable npm global prefix (a Node version manager
qualifies; if the global install can't write, setup continues and prints the exact
version-pinned `npm install -g` fallback to run yourself). E2e-validated on macOS, Linux,
and Windows (PowerShell + cmd):

```bash
npx -y insta@latest setup agent
```

This command means **production** (CLI ≥ 0.0.38): if the machine was previously switched to
staging it switches back — announced, session dropped, like `insta env use prod`. Staging is
its own explicit command, which also persists the choice:

```bash
npx -y insta@latest setup agent --env staging
```

On macOS/Linux without Node, the native-binary installer puts the `insta` CLI on PATH (the
skill + MCP steps it then runs still need Node — the skills tool runs via npx). Never run it
on native Windows — PowerShell's `curl` alias and the WSL `bash` shim break it; use npx
above, or download `insta-windows-x64.exe` from the
[releases page](https://github.com/InsForge/instacloud-cli/releases):

```bash
curl -fsSL agents.instacloud.com | sh
```

Pin a version with `INSTA_VERSION=v0.0.22`; change the install directory with
`INSTA_INSTALL_DIR`. While the CLI is pre-1.0 it updates itself on new releases. Turn that
off with `insta autoupdate off`.

## Quickstart

```bash
insta login
insta project create my-app
insta services add postgres db
insta services add compute api
insta secrets bind DATABASE_URL postgres/db --to compute/api
insta secrets
insta deploy .
```

`project create` makes an empty project and links the current directory. Services are
opt-in, so you add only what you need. `secrets` writes the current branch's user-defined
secrets to `./.env` (the postgres connection string is read with `insta db url`). `deploy .`
builds the directory remotely and ships it to the branch's compute
service, with no local Docker. Whether it needs a `Dockerfile` depends on where the
service runs: on insta-compute it is optional, and a directory without one is built
by nixpacks on the build gateway; on Fly-backed services one is still required.

## Authentication

```bash
insta login                                  # sign in from the browser (any account type)
insta login --email you@example.com          # password from $INSTA_PASSWORD or a prompt
insta login --oauth github                   # or google, through the browser
insta login --env staging                    # log in to a specific deployment
```

Tokens are stored in `~/.insta/config.json` and refresh automatically.

Bare `insta login` opens the console's device-approval page in your browser: sign in there
with whatever your account uses (email, GitHub, Google), check the code matches, and approve.
On a machine that can't open a browser, `--device` prints the same link to open from any
other device.

`--oauth` starts a loopback listener on `127.0.0.1`, opens the browser at the control
plane's `/auth/cli/authorize`, and receives the token back on that listener once the
provider has authorized you. Nothing is pasted by hand.

If you operate your own control plane, the provider's OAuth app needs
`GITHUB_OAUTH_CLIENT_ID` / `GITHUB_OAUTH_CLIENT_SECRET` (or the `GOOGLE_*` equivalents), and
its callback URL must be `{INSTA_API_BASE_URL}/api/auth/callback/<provider>` — the control
plane's address, not the CLI's loopback address.

## How it works

### Services are branch-scoped

A project holds services (`postgres`, `storage`, `compute`) and each branch owns its own
set. `insta branch create feature-x` forks the parent's services: a copy-on-write database
branch per Postgres, a copy-on-write bucket per storage, a clone of every compute service. From there
the two branches diverge independently. A project is capped at 10 branches.

### Credentials come from the secret seam, not a file you maintain

`insta secrets` fetches the current branch's **user-defined** secrets and writes `./.env`.
`insta run <cmd>` does the same without touching disk, injecting them into the child process
only. Provider-minted service credentials (`DATABASE_URL`, `BUCKET_NAME`,
`AWS_ACCESS_KEY_ID`, …) are not in that bundle — they reach compute through explicit
`insta secrets bind` rules, and the postgres connection string is read directly with
`insta db url` (or `insta db connect` for a psql session).

Secrets can be scoped per compute service, so several services may each define the same name — and
a flat bundle cannot carry two values for one name. Such a name is **withheld** from the bundle and
reported on stderr (which services define it, and how to read one). `insta run` then **refuses to
start the command** rather than let it inherit a stale value for that name from your shell; re-run
it as `insta run --service compute/<name>` to inject exactly what that one service receives, or
`--ignore-collisions` to run with the name removed from the child environment altogether.
`insta secrets --service compute/<name>` reads the same scoped env into `.env`.

### Destructive actions can require approval

Agent requests are governed by the project's `agent-policy`; human requests use normal RBAC.
Where the agent policy says `approve`, the command stops and prints an approval id for a human
admin to grant with `insta approvals approve <id>`. The agent then retries the unchanged request.
Run `insta --agent agent-policy get --json` for stored overrides, `defaultRules`, `effectiveRules`,
`bootstrapRules` and `ruleNotes`. Rules distinguish no affected branches (`project`), unprotected
branches and protected branches. They describe policy, not authorization: RBAC, session checks,
actual affected resources and compound actions still apply. An empty override object does not
mean rules are unavailable. Text output also lists effective rules. The old `policy` command and approval
`--always` option have been removed.

### Agents get the same surface

`insta manifest` prints an agent-legible view of every branch and its URLs. `insta setup
agent` installs the InstaCloud skill and registers the remote MCP server for the coding
agents on the machine — and, when running from the npx cache with no durable `insta` on
PATH, first installs the CLI itself globally.

## Environments

`prod` and `staging` are separate deployments, in different regions, with different
databases and different auth. A session minted by one cannot authenticate against the
other, so switching environments drops the stored session and you log in again.

| | `prod` (default) | `staging` |
|---|---|---|
| control plane | `api.instacloud.com` | `api.staging.instacloud.com` |
| MCP server | `mcp.instacloud.com/mcp` | `mcp.staging.instacloud.com/mcp` |
| MCP registers as | `insta-cloud` | `insta-cloud-staging` |
| agent skills | `InsForge/instacloud-skills` | `InsForge/instacloud-skills#devel` |
| CLI channel | latest stable release | newest prerelease, else stable |

```bash
insta env                 # current environment and everything derived from it
insta env use staging     # switch; persisted to ~/.insta/config.json
```

The control plane, the MCP host and the skill source all resolve from that one switch, so a
machine cannot end up running staging while its agents read production's skill text. The
two MCP registrations use different names, so both environments can be installed side by
side.

To install against staging directly:

```bash
curl -fsSL agents.staging.instacloud.com | sh
```

That host is a CloudFront cache, so after a change to the installer it can serve the
previous copy for up to about a day. This form is equivalent and always current:

```bash
curl -fsSL https://raw.githubusercontent.com/InsForge/instacloud-cli/main/install.sh | sh -s -- --agents --staging
```

If the environment cannot be applied — an installed CLI older than 0.0.23 has no `insta
env` — the installer exits non-zero and says so, rather than leaving you silently pointed
at production. The canonical usage is `curl … | sh && insta project create`, often run
unattended by an agent, and a silent fallback there would provision real production
infrastructure.

Resolution order, most specific first:

1. `INSTA_API_URL` — a literal URL, and the only way to reach a host no environment name
   covers, such as a local daemon or a preview deployment. `INSTA_MCP_URL` and
   `INSTA_SKILLS_REPO` do the same for the MCP host and the skill source.
2. `INSTA_ENV` — `prod` or `staging`. An unrecognised value is an error, never a fallback.
3. The `apiUrl` persisted in `~/.insta/config.json`.
4. `prod`.

Prereleases publish with `--prerelease` on GitHub and under npm's `next` tag, so a staging
build never reaches a production installer.

## Commands

`insta --help` is the authoritative list. For flags, approval gates and plan limits, see the
[full command reference](https://github.com/InsForge/instacloud-skills/blob/main/insta/cli-reference.md).

| Command | What it covers |
|---|---|
| `insta login` · `logout` · `status` | Browser sign-in (default), `--email` + password, or `--oauth github\|google`; `status` shows the environment, login and linked project/branch |
| `insta env` | `show` · `use <prod\|staging>` |
| `insta setup` | `agent` — install the CLI (if missing), the skill, and MCP for every coding agent; targets prod, `--env staging` for staging |
| `insta mcp` | `install` — register the remote MCP server only |
| `insta org` | `list` · `create` (one free org per user) |
| `insta project` | `create` · `list` · `link` · `delete` |
| `insta branch` | `create` · `list` · `switch` · `delete` · `merge` |
| `insta services` | `add` · `list` · `remove` · `rename` · `set-access` · `scale` · `upgrade` · `secrets` |
| `insta secrets` | Write `.env`, plus `list` · `set` · `unset` · `tree` |
| `insta cron` | Branch-scoped HTTP schedules: `list` · `create` · `show` · `edit` · `pause` · `resume` · `delete` · `run` · `runs` · `preview`. Expressions are UTC and so is every time printed; `run` is one EXTRA execution and does not consume the next scheduled tick; header values are write-only, so `show` lists header names only |
| `insta run <cmd>` | Run a command with the branch bundle injected, nothing written to disk |
| `insta deploy [dir]` | Deploy a source directory (built remotely) or `--image <url>` |
| `insta compute` | `start` · `stop` · `suspend` · `status` · `set-domain` · `check-domain` · `remove-domain` |
| `insta domain` | Buy a domain through InstaCloud: `search` · `buy` · `attach` · `list` · `status` |
| `insta db` | `url` (print the postgres DSN) · `connect` (psql session) · `limits` · `stats` · `always-on` · `volume` |
| `insta regions` | Regions available for postgres and compute |
| `insta manifest` | Agent-legible view of every branch and its URLs |
| `insta build-logs <id>` | Read source-build output; `--source archive` (default) uses the deploy operation ID, `--source github` uses a GitHub build ID; `--follow` watches output, `--json` returns one snapshot |
| `insta metrics` · `logs` · `events` | Service metrics; runtime logs (`--deploy` for deploy events); audit timeline |
| `insta usage` · `billing` | Usage by billing dimension; `billing upgrade` · `billing portal` |
| `insta approvals` | `list` · `approve` · `deny` |
| `insta agent-policy` | `get` · `set <mode>` · `protect-branch` · `unprotect-branch` · `rule set <action> <decision>` · `revoke-sessions` |
| `insta observe` | `install` · `uninstall` · `report` · `sync` — local credential audit |
| `insta feedback` | Report an InstaCloud-side hurdle (bug / feature-request / friction) to the team — never for the app you are building; works logged-out |
| `insta upgrade` · `autoupdate` | Update the CLI; show or set auto-update |

## Configuration

| Location | Contents |
|---|---|
| `~/.insta/config.json` | API URL, access and refresh tokens, user, auto-update preference |
| `./.insta/project.json` | Project id, org id, current branch |
| `./.insta/link-plane.json` | The control-plane URL this machine linked against. Gitignored and per machine; a link made against a different control plane is refused rather than reused. The home directory is never a project |

| Variable | Effect |
|---|---|
| `INSTA_API_URL` | Control-plane URL; outranks every other source |
| `INSTA_ENV` | `prod` or `staging` |
| `INSTA_MCP_URL` · `INSTA_SKILLS_REPO` | Override the MCP host and the agent-skill source |
| `INSTA_PROJECT_ID` · `INSTA_ORG_ID` · `INSTA_BRANCH` | Target a project, org or branch without linking |
| `INSTA_PASSWORD` | Password for non-interactive login |
| `INSTA_NO_AUTOUPDATE` | Disable self-update |
| `INSTA_NO_TELEMETRY` · `DO_NOT_TRACK` | Disable usage analytics. Each command sends one event (command, flags, outcome, version, OS) to the same PostHog project as the console. Only ids, enums and numbers among the arguments are kept — names, branches, keys, paths, secret values, free text and error messages never leave the machine; custom API hosts report nothing. Before you sign in, events carry a random id stored in `~/.insta/telemetry.json`; the first command after you sign in sends one extra event merging that id into your account, and the first command after the session ends (logout, `env use`) retires it |

## Agent skills

The `insta` skill and its task guides live in
[InsForge/instacloud-skills](https://github.com/InsForge/instacloud-skills). `insta setup agent`
installs it user-globally for every coding agent on the machine. `insta project create` and
`insta project link` additionally install the stack skills (Tigris, Better Auth) into the
project, along with the `insta observe` credential-audit hook. Postgres needs no stack
skill — it's plain Postgres, reached directly via `DATABASE_URL`.

## Contributing

Dev loop, architecture, cross-compilation and the release process are in
[CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests are welcome.

## License

Apache 2.0. See [LICENSE](LICENSE).
