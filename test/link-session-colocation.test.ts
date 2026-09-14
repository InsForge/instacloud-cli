// A link and its agent session must resolve to the SAME root. `insta project link` in agent mode
// saves the session BEFORE writing the link (the GET that confirms the project is a project route,
// signed with that session). If writeProject then chose a different directory than the one the
// session was saved in, every later agent request looked for the session where it is not, and the
// ancestor project's own session had been overwritten. Pinned here from the caller's order.
import { test, expect } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAgentSession, saveAgentSession } from '../src/agent.js'
import { findProjectRoot, writeProject } from '../src/config.js'

const API = 'https://test.invalid'
function session(projectId: string) {
  const pair = generateKeyPairSync('ed25519')
  return {
    token: 't', agentSessionId: `ags_${projectId}`, projectId, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), client: 'codex' as const, apiUrl: API,
  }
}

test('agent-mode link from a subdirectory: the session is found where the link lands', async () => {
  const root = mkdtempSync(join(tmpdir(), 'insta-colo-'))
  const sub = join(root, 'packages', 'a')
  mkdirSync(sub, { recursive: true })
  await writeProject({ projectId: 'p-1', orgId: 'o', branch: 'main' }, root)

  // projectLink's order: the session first, then the link.
  await saveAgentSession(session('p-2'), sub)
  await writeProject({ projectId: 'p-2', orgId: 'o', branch: 'main' }, sub)

  expect(await findProjectRoot(sub)).toBe(root)
  expect((await loadAgentSession(API, 'p-2', sub)).agentSessionId).toBe('ags_p-2')
})
