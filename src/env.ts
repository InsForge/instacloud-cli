// InstaCloud deployment environments.
//
// `prod` and `staging` are SEPARATE deployments — different regions, different databases, different
// Better Auth instances — not one backend behind two names. api.instacloud.com is
// insta-platform-prod-alb (us-east-2); api.staging.instacloud.com is insta-beta-api-lb (us-west-1).
// The practical consequence, learned the hard way when beta-api was retired: a session minted by
// one environment can NEVER authenticate against the other, and its refresh token must never be
// POSTed there. So every environment switch drops the stored session (see config.ts).
//
// Each environment owns a matched set of hosts. They are resolved together, from a single switch,
// because the failure mode of resolving them independently is silent and bad: point the API at
// staging, forget the MCP URL, and the machine talks to staging while its agents talk to prod.
export type EnvName = 'prod' | 'staging'

export type EnvHosts = {
  api: string
  mcp: string
  // The agent-skill source passed to `npx skills add`, as `owner/repo` or `owner/repo#ref`.
  // Staging pins the integration branch so a staging install gets the skill text that documents
  // the staging control plane, rather than whatever is published on the default branch.
  //
  // The ref MUST use the `#ref` fragment form. `owner/repo@thing` looks like a ref but the skills
  // tool parses `@` as a SKILL-NAME FILTER, silently leaving the source on the default branch —
  // and its progress line still echoes "Source: …insta-skills.git @thing", so it reads as if the
  // ref took effect. Verified by installing both forms and diffing the result: `#docs/staging-env`
  // produced that branch's cli-reference.md, `@docs/staging-env` produced main's.
  skills: string
}

export const ENVS: Record<EnvName, EnvHosts> = {
  prod: {
    api: 'https://api.instacloud.com',
    mcp: 'https://mcp.instacloud.com/mcp',
    skills: 'InsForge/instacloud-skills',
  },
  staging: {
    api: 'https://api.staging.instacloud.com',
    mcp: 'https://mcp.staging.instacloud.com/mcp',
    skills: 'InsForge/instacloud-skills#devel',
  },
}

export const DEFAULT_ENV: EnvName = 'prod'

export const ENV_NAMES = Object.keys(ENVS) as EnvName[]

export function isEnvName(v: string): v is EnvName {
  return (ENV_NAMES as string[]).includes(v)
}

/** Strip trailing slashes so 'https://x/' and 'https://x' compare equal. */
export const normalizeUrl = (url: string): string => url.replace(/\/+$/, '')

/** The environment a persisted apiUrl belongs to, or null for a custom/self-hosted host
 *  (insta-oss on localhost, a preview deployment). null is not an error — it means "the user
 *  chose this URL deliberately", and callers must leave such a choice alone. */
export function envForApiUrl(apiUrl: string): EnvName | null {
  const want = normalizeUrl(apiUrl)
  return ENV_NAMES.find((n) => normalizeUrl(ENVS[n].api) === want) ?? null
}

/** $INSTA_ENV, validated. An unrecognised value throws rather than falling back to prod: a
 *  typo'd `INSTA_ENV=stagng` that silently provisions real infrastructure in production is the
 *  worst possible outcome, and it would be invisible until the bill arrived. */
export function envFromEnvVar(raw = process.env.INSTA_ENV): EnvName | null {
  if (raw === undefined) return null
  const v = raw.trim().toLowerCase()
  if (v === '') return null
  if (!isEnvName(v)) {
    throw new Error(`unknown INSTA_ENV "${raw}" — expected one of: ${ENV_NAMES.join(', ')}`)
  }
  return v
}

/** MCP registration name for an environment.
 *
 *  Prod keeps the bare `insta-cloud` name — it is the installed base, and renaming it would
 *  orphan every existing registration. Other environments get a suffix so they can coexist on
 *  one machine. This matters more than it looks: `registerMcp` treats an already-registered
 *  name as "nothing to do", and the config-file agents key their entry by name, so sharing one
 *  name across environments leaves a staging install silently wired to the prod MCP server
 *  while reporting success. */
export function mcpServerName(env: EnvName): string {
  return env === DEFAULT_ENV ? 'insta-cloud' : `insta-cloud-${env}`
}
