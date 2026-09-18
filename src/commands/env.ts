// `insta env` — show or switch the deployment environment (prod | staging).
//
// This exists because the canonical install is a pipe: `curl -fsSL agents.staging.instacloud.com | sh`.
// A piped script cannot export anything into the parent shell, so the staging one-liner has no way
// to make `INSTA_ENV=staging` stick for the `insta project create` the user runs next. Persisting
// the choice into ~/.insta/config.json is the only mechanism that survives the pipe — and it is the
// same file `login --api-url` already writes, so this adds a surface, not a concept.
import { readPersistedGlobal, resolveEnv, writeGlobal, type GlobalConfig } from '../config.js'
import { DEFAULT_ENV, ENVS, ENV_NAMES, envForApiUrl, isEnvName, mcpServerName, normalizeUrl, type EnvName } from '../env.js'
import { die, info, printJson } from '../util.js'

export async function envShow(opts: { json?: boolean }): Promise<void> {
  const { apiUrl, env, mcpUrl, skills } = await resolveEnv()
  const mcpServer = mcpServerName(env ?? DEFAULT_ENV)
  if (opts.json) return printJson({ env, apiUrl, mcpUrl, mcpServer, skills })
  info(`env:     ${env ?? '(custom)'}`)
  info(`api:     ${apiUrl}`)
  info(`mcp:     ${mcpUrl} (${mcpServer})`)
  info(`skills:  ${skills}`)
  if (!env) info('  (custom apiUrl — `insta env use <name>` to switch to a named environment)')
}

// One stable schema for BOTH envUse outcomes (no-op and real switch), so a scripted caller can key
// on any field — mcpServer, previous — without probing which branch ran. Pure, unit-tested.
export function envUseResult(target: EnvName, previous: string | null, changed: boolean, sessionDropped: boolean) {
  return {
    env: target,
    previous,
    apiUrl: ENVS[target].api,
    mcpUrl: ENVS[target].mcp,
    mcpServer: mcpServerName(target),
    changed,
    sessionDropped,
  }
}

export async function envUse(name: string, opts: { json?: boolean } = {}): Promise<void> {
  const want = name.trim().toLowerCase()
  if (!isEnvName(want)) die(`unknown environment "${name}" — expected one of: ${ENV_NAMES.join(', ')}`)
  const target: EnvName = want

  const nextApi = ENVS[target].api
  // The PERSISTED config, deliberately not the override-resolved view — see readPersistedGlobal.
  const stored = await readPersistedGlobal()
  const from = envForApiUrl(stored.apiUrl)

  // Compare normalised, so a stored trailing slash is recognised as the same environment (which is
  // how envForApiUrl already treats it) instead of being rewritten as a "switch" that needlessly
  // drops a perfectly good session.
  if (normalizeUrl(stored.apiUrl) === normalizeUrl(nextApi)) {
    if (opts.json) return printJson(envUseResult(target, from ?? target, false, false))
    info(`already on ${target} (${nextApi})`)
    return
  }

  // A real switch, so drop the stored session unconditionally. prod and staging are separate
  // deployments: the old token cannot authenticate here, and keeping it is actively unsafe because
  // api.ts's 401 path POSTs the refresh token to whatever apiUrl now resolves to, handing one
  // deployment's credential to another. Same reasoning as the retired-host path in config.ts.
  //
  // "Any field" rather than accessToken alone: a config holding only a refreshToken (an interrupted
  // login, a hand-edited file) would otherwise keep that token and post it to the new host.
  const hadSession = !!(stored.accessToken || stored.refreshToken || stored.user)
  const next: GlobalConfig = { ...stored, apiUrl: nextApi }
  delete next.accessToken
  delete next.refreshToken
  delete next.user
  delete next.agentCredential
  await writeGlobal(next)

  if (opts.json) return printJson(envUseResult(target, from ?? null, true, hadSession))
  info(`switched ${from ?? '(custom)'} → ${target}`)
  info(`  api: ${nextApi}`)
  info(`  mcp: ${ENVS[target].mcp} (registers as \`${mcpServerName(target)}\`)`)
  if (hadSession) info('  previous session dropped (separate deployment) — run `insta login`')
  // Switching the CLI does NOT re-point already-installed agents: their MCP registration and skill
  // files were written for the previous environment and are keyed by a different server name, so
  // they keep talking to it until setup is re-run. --env is REQUIRED in the hint: since 0.0.38 a
  // bare `setup agent` forces prod, which would silently undo the switch the user just made.
  info(`  re-point this machine's agents at it with: insta agent setup --env ${target}`)
}
