import { ApiClient, requireProject } from '../api.js'
import { BuildLogPrinter, followBuildLogs, readBuildLogs } from '../build-logs.js'
import { info, printJson } from '../util.js'

export async function buildLogs(buildId: string, opts: { source: string; follow?: boolean; json?: boolean }): Promise<void> {
  if (opts.source !== 'github' && opts.source !== 'archive') throw new Error('--source must be github or archive')
  if (opts.follow && opts.json) throw new Error('--follow cannot be combined with --json')
  const api = await ApiClient.load()
  const { projectId } = await requireProject()
  if (opts.follow) return followBuildLogs(api, projectId, opts.source, buildId, (text) => { process.stdout.write(text) })
  const snapshot = await readBuildLogs(api, projectId, opts.source, buildId)
  if (opts.json) return printJson(snapshot)
  const printer = new BuildLogPrinter()
  const write = (text: string) => { process.stdout.write(text) }
  printer.print(snapshot, write)
  printer.finishLine(write)
  if (snapshot.state !== 'ready') info(`Build logs ${snapshot.state}`)
}
