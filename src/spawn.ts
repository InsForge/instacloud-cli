import { existsSync, statSync } from 'node:fs'
import { dirname, join, win32 } from 'node:path'

export const isRunnableFile = (path: string, win: boolean): boolean => {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return false
    return win || (stat.mode & 0o111) !== 0
  } catch { return false }
}

/** Read an environment variable the way Windows itself does: case-insensitively.
 *  `process.env` is already case-insensitive on win32, but a COPY of it (`{ ...process.env }`,
 *  which every caller that adds a variable makes) is an ordinary object that keeps whatever
 *  casing Windows used — and Windows overwhelmingly spells it `Path`, not `PATH`. Reading
 *  `env.PATH` off such a copy yields undefined, nothing resolves, and the caller falls back to
 *  spawning the bare `.cmd` shim this module exists to avoid. */
export function envVar(env: NodeJS.ProcessEnv, name: string, win: boolean): string | undefined {
  const direct = env[name]
  if (direct !== undefined || !win) return direct
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(env)) if (key.toLowerCase() === wanted) return value
  return undefined
}

/** Resolve a bare command name to its absolute PATH location (PATHEXT-aware on Windows).
 *  cmd.exe searches the CURRENT DIRECTORY before PATH for bare names, so callers must pass
 *  the absolute shim path to the cmd.exe wrapper below. */
export function whichOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const win = platform === 'win32'
  const exts = win ? [...(envVar(env, 'PATHEXT', win) ?? '.COM;.EXE;.BAT;.CMD').split(';'), ''] : ['']
  for (const dir of (envVar(env, 'PATH', win) ?? '').split(win ? ';' : ':')) {
    if (!dir) continue
    for (const ext of exts) {
      const path = join(dir, bin + ext)
      if (isRunnableFile(path, win)) return path
    }
  }
  return null
}

// On Windows `npm`/`npx` and most npm-installed CLIs are .cmd shims, which spawn() without a
// shell refuses. Prefer re-entering npm/npx through node; otherwise resolve a safe absolute shim
// path and invoke it through cmd.exe. Kept shared so every child-process call uses the same rules.
export function resolveSpawnable(
  cmd: string,
  args: string[],
  npmExecpath = process.env.npm_execpath,
  execPath = process.execPath,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  systemRoot: string = process.env.SYSTEMROOT ?? process.env.windir ?? 'C:\\Windows',
): { cmd: string; args: string[]; windowsVerbatimArguments?: boolean } {
  const execIsNode = /(^|[\\/])node(\.exe)?$/i.test(execPath)
  if ((cmd === 'npm' || cmd === 'npx') && execIsNode) {
    if (npmExecpath && /(^|[\\/])np[mx](-cli)?\.[cm]?js$/.test(npmExecpath)) {
      const cli = npmExecpath.replace(/np[mx](-cli)?(\.[cm]?js)$/, `${cmd}$1$2`)
      if (existsSync(cli)) return { cmd: execPath, args: [cli, ...args] }
    }
    const nodeDir = dirname(execPath)
    const besideNode = platform === 'win32'
      ? join(nodeDir, 'node_modules', 'npm', 'bin', `${cmd}-cli.js`)
      : join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', `${cmd}-cli.js`)
    if (existsSync(besideNode)) return { cmd: execPath, args: [besideNode, ...args] }
  }

  const bareShim = !/[\\/]/.test(cmd) && !/\.exe$/i.test(cmd)
  if (platform === 'win32' && bareShim && !args.some((arg) => /[&|<>^%"\r\n]/.test(arg))) {
    const absolute = whichOnPath(cmd, env, platform)
    if (absolute && !/[&|<>^%"\r\n]/.test(absolute)) {
      const command = [absolute, ...args].map((arg) => `"${arg.replace(/\\+$/, '$&$&')}"`).join(' ')
      // cmd /s consumes the outer quotes; libuv must not escape the inner argument quotes.
      return {
        cmd: win32.join(systemRoot, 'System32', 'cmd.exe'),
        args: ['/d', '/v:off', '/s', '/c', `"${command}"`],
        windowsVerbatimArguments: true,
      }
    }
  }
  return { cmd, args }
}
