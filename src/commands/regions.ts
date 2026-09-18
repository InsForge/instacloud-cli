import { ApiClient } from '../api.js'
import { info, printJson } from '../util.js'

// insta config regions — list the regions a postgres/compute service can be created in.
export async function regionsList(opts: { json?: boolean } = {}, deps?: { api: Pick<ApiClient, 'request'> }): Promise<void> {
  const api = deps?.api ?? await ApiClient.load()
  const { regions } = await api.request('GET', '/regions')
  if (opts.json) return printJson(regions)
  for (const r of regions) info(`${r.slug}  ${r.label}`)
}
