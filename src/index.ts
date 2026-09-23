#!/usr/bin/env node
import { Command, Option } from 'commander'
import { configureAgent, detectAgent } from './agent.js'
import { setApiUrlOverride } from './config.js'
import * as agentPolicy from './commands/agent-policy.js'
import { ApiError, AgentApprovalRequired } from './api.js'
import { CliCancel, CliExit, fail, relayedExitCode } from './util.js'
import { trackCommand } from './telemetry.js'
import { cliVersion } from './version.js'
import * as auth from './commands/auth.js'
import * as envCmd_ from './commands/env.js'
import { ENV_NAMES } from './env.js'
import * as setup from './commands/setup.js'
import * as mcp from './commands/mcp.js'
import * as runCmd from './commands/run.js'
import * as org from './commands/org.js'
import * as project from './commands/project.js'
import * as branch from './commands/branch.js'
import * as services from './commands/services.js'
import { resolveServiceArgs, serviceArgsDeps } from './resolve-service.js'
import * as regions from './commands/regions.js'
import * as secretsCmd from './commands/secrets.js'
import * as cronCmd from './commands/cron.js'
import { deploy } from './commands/deploy.js'
import { build } from './commands/build.js'
import { buildLogs } from './commands/build-logs.js'
import * as computeCmd from './commands/compute.js'
import * as githubCmd from './commands/github.js'
import * as pgCmd from './commands/postgres.js'
import * as dbQueryCmd from './commands/db-query.js'
import * as managedDb from './commands/managed-db.js'
import * as storageCmd from './commands/storage.js'
import { manifest } from './commands/manifest.js'
import * as template from './commands/template.js'
import * as govern from './commands/govern.js'
import * as observe from './commands/observe.js'
import * as obs from './commands/metrics.js'
import { billing, billingUpgrade, billingPortal } from './commands/billing.js'
import * as domainCmd from './commands/domain.js'
import * as selfUpdate from './commands/upgrade.js'
import * as feedbackCmd from './commands/feedback.js'

function onError(e: unknown): void {
  if (e instanceof AgentApprovalRequired) {
    if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(e.body) + '\n')
    else process.stderr.write(e.message + '\n')
    process.exitCode = 2
    return
  }
  if (e instanceof CliExit || e instanceof CliCancel) return
  if (e instanceof ApiError) return fail(`${e.message} (HTTP ${e.status})`)
  fail(e instanceof Error ? e.message : String(e))
}

// Wrap an async action so rejections surface as clean CLI errors.
// commander appends (options, command) to every action's arguments, so the command is always last.
const guard = (fn: (...a: any[]) => Promise<unknown>) => async (...a: any[]): Promise<void> => {
  const started = Date.now()
  let error: unknown
  try { await fn(...a) } catch (e) { error = e; onError(e) }
  await trackCommand(a[a.length - 1] as Command, a.slice(0, -2), {
    error, durationMs: Date.now() - started, exitCode: Number(process.exitCode ?? 0), childExitCode: relayedExitCode(),
  }, cliVersion())
}

const program = new Command()
// Positional options: some command groups (e.g. `secrets`, `billing`) declare a flag (like
// --branch or --org) both on the group itself (for its own default action) and on a subcommand
// of that group. Without this, commander lets the group's own option greedily match the flag
// no matter where it appears, so e.g. `secrets set NAME val --branch b` silently drops --branch
// into the (unused) group-level options instead of the subcommand's. Positional parsing makes a
// group's own options only match before the subcommand name, so occurrences after it are matched
// against the subcommand's own (identically-named) option instead.
program.enablePositionalOptions()
program.name('insta').description('InstaCloud CLI — manage projects, branches, services, deploys').version(cliVersion())
program.option('--agent', 'run as an agent with a verified project session and project agent policy')
program.option('--api-url <url>', 'control-plane API base URL for this invocation only — beats INSTA_API_URL, INSTA_ENV and the stored login; a URL for another deployment runs logged-out (internal debugging). Accepted before or after any subcommand (except `compute exec`: pass it before `compute` there)')
// The runtime --api-url must be in place before any action loads config (ApiClient.load →
// readGlobal). optsWithGlobals merges the root's, a group's and the leaf's copy of the flag
// (addApiUrlEverywhere below), so it is honoured wherever it was typed; typed twice, the outermost wins.
program.hook('preAction', (_root, action) => setApiUrlOverride((action.optsWithGlobals() as { apiUrl?: string }).apiUrl))
program.hook('preAction', () => configureAgent(detectAgent(!!program.opts().agent)))

// ---- auth ----
program.command('login').description('Log in — bare: sign in from your browser (any account type); or --email <email> + password, --oauth <github|google>, --device (headless), --claim <email> (agent: the named user confirms a code), --api-key <insta_…> (headless, durable token)')
  .option('--email <email>', 'account email (email + password login)')
  .option('--password <password>', 'account password (else $INSTA_PASSWORD or prompt; needs --email)')
  .option('--oauth <provider>', 'browser OAuth login: github | google')
  .option('--device', 'device-code login: like bare login but never opens a browser here — approve from any other machine (VMs, SSH, CI)')
  .option('--claim <email>', 'agent login confirmed by that user: prints a console link + 6-digit code; they sign in as that email and type the code, and the resulting insta_ key is stored here')
  .option('--api-key <key>', 'non-interactive login with a durable insta_ API token (headless agents / CI)')
  .option('--api-url <url>', 'control-plane API base URL')
  .option('--env <name>', `deployment environment: ${ENV_NAMES.join(' | ')}`)
  .action(guard((o) => auth.login(o)))
program.command('logout').description('Log out and clear local tokens — always the stored session, so --api-url (and INSTA_API_URL / INSTA_ENV) do not apply here').action(guard(() => auth.logout()))
program.command('status').description('Show login + linked project').option('--json').action(guard((o) => auth.status(o)))

// ---- environment (prod | staging) — hidden: `--api-url` covers the debugging case; kept working ----
const envCmd = program.command('env', { hidden: true }).description('Show or switch the deployment environment (prod | staging)')
envCmd.command('show', { isDefault: true }).description('Show the current environment and its hosts')
  .option('--json').action(guard((o) => envCmd_.envShow(o)))
envCmd.command('use <name>').description(`Switch environment (${ENV_NAMES.join(' | ')}) — drops the stored session, which is deployment-specific`)
  .option('--json').action(guard((name, o) => envCmd_.envUse(name, o)))

// ---- org ----
const orgCmd = program.command('org').description('Manage organizations')
orgCmd.command('list').option('--json').action(guard((o) => org.orgList(o)))
orgCmd.command('create <name>').option('--json').action(guard((name, o) => org.orgCreate(name, o)))

// ---- project ----
const pj = program.command('project').description('Manage projects')
pj.command('create [name]').option('--org <id>', 'org to create under (default: personal)').option('--json').action(guard((name, o) => project.projectCreate(name, o)))
pj.command('list').option('--org <id>').option('--json').action(guard((o) => project.projectList(o)))
pj.command('link <id>').description('Link a project to this directory').option('--json').action(guard((id, o) => project.projectLink(id, o)))
pj.command('delete').option('--project <id>').option('--json').action(guard((o) => project.projectDelete(o)))

// ---- branch ----
const br = program.command('branch').description('Manage branch environments')
br.command('create <name>').option('--from <branch>', 'parent branch (default: current)').option('--json').action(guard((name, o) => branch.branchCreate(name, o)))
br.command('list').option('--json').action(guard((o) => branch.branchList(o)))
br.command('switch <name>').option('--json').action(guard((name, o) => branch.branchSwitch(name, o)))
br.command('delete <name>').option('--json').action(guard((name, o) => branch.branchDelete(name, o)))
br.command('merge <source>').description('Merge a branch service set into another (structural, no data)')
  .option('--into <branch>', 'target branch (default: current)').option('--json').action(guard((source, o) => branch.branchMerge(source, o)))

// ---- service (opt-in postgres/storage/compute/redis/mysql/mongodb) ----
const svc = program.command('service').aliases(['services', 'svc']).description('Manage project services: add / list / remove / rename (postgres|storage|compute|redis|mysql|mongodb)')
// [type] [name] are optional so the command can answer "what can I add?" — a terminal is walked
// through the dashboard's Add Service kinds, anything else gets that list back as an error
// (resolve-service.ts). Picking Docker Image also fills in --image/--port from the answers.
svc.command('add [type] [name]').description('Provision a service on demand (assigns a default domain for postgres/compute); with no type/name, a terminal picks from the service kinds')
  .option('--branch <branch>', 'target branch (default: current)')
  .option('--region <region>', 'region for postgres/compute/managed databases, e.g. us-east (see `insta config regions`)')
  .option('--public', 'storage only: serve the bucket with anonymous public-read (default private)')
  .option('--image <url>', 'compute only: run this container image at creation')
  .option('--port <n>', 'compute only: port the image listens on (default 8080)')
  .option('--always-on', 'compute only: create as always-on — never scales to zero (the default for new compute services; all plans; billing is actual usage either way)')
  .option('--no-always-on', 'compute only: create as scale-to-zero — idle machines suspend and wake on the next request')
  .option('--mount-path <path>', 'compute only: container mount path for a new volume (requires --volume; default /data)')
  .option('--volume <gi>', 'compute only: attach a persistent volume of this many whole Gi (also attachable later: `insta compute volume <name> --size <gi>`). Any plan may attach up to its own plan cap (10Gi free, 50Gi paid by default; the bare `insta compute volume <name>` read prints it as plan max); a size above the free cap is paid. Volume services keep 1 machine and stop (cold wake) instead of suspend when idle')
  .option('--json')
  .action(guard(async (type, name, o) => {
    const a = await resolveServiceArgs(type, name, serviceArgsDeps(o.json), o)
    return services.servicesAdd(a.type, a.name, { ...o, image: a.image ?? o.image, port: a.port ?? o.port })
  }))
svc.command('list').option('--json').option('--branch <branch>', 'branch (default: current)')
  .action(guard((o) => services.servicesList(o)))
svc.command('remove <type> <name>').description('Remove a service and destroy its resources')
  .option('--branch <branch>', 'branch (default: current)').option('--json')
  .action(guard((type, name, o) => services.servicesRemove(type, name, o)))
svc.command('rename <type> <name> <new-name>').description('Rename a service and re-key its managed secret names')
  .option('--json').option('--branch <branch>', 'branch (default: current)')
  .action(guard((type, name, newName, o) => services.servicesRename(type, name, newName, o)))

// ---- secrets (seam) ----
const sec = program.command('secrets').description('Fetch the credential bundle (secret seam) into .env')
  .option('--branch <branch>')
  .option('--service <type/name>', "read one compute service's own slice of the bundle instead of the branch-wide merge, e.g. compute/api")
  .option('-o, --output <file>', 'output file (default .env)').option('--print', 'print instead of writing').option('--json')
  .action(guard((o) => secretsCmd.secrets(o)))
// commander 12 defaults allowExcessArguments to true, so a mistyped/retired subcommand (e.g.
// `secrets lst`) would otherwise run this group's own action instead of failing.
sec.allowExcessArguments(false)
sec.command('list').description('List secret names, grouped by service').option('--branch <branch>').option('--json').action(guard((o) => secretsCmd.secretsList(o)))
sec.command('set <name> [value]').description('Set a user secret (project-wide; value from stdin if omitted)')
  .option('--branch <branch>', 'scope to one branch').option('--service <type/name>', 'bind to a branch service (implies current branch)')
  .option('--json').action(guard((n, v, o) => secretsCmd.secretsSet(n, v, o)))
sec.command('unset <name>').description('Remove a user secret')
  .option('--branch <branch>', 'scope to one branch')
  .option('--service <type/name>', "remove only that service's copy, e.g. compute/api")
  .option('--json').action(guard((n, o) => secretsCmd.secretsUnset(n, o)))
sec.command('bind <env-name> <source>').description('Bind a service credential into a compute env var')
  .option('--branch <branch>', 'branch (default: current)')
  .option('--to <compute-service>', 'target compute service, e.g. compute/api')
  .option('--source-name <name>', 'source credential name when the source exposes more than one')
  .option('--json')
  .action(guard((n, source, o) => secretsCmd.secretsBind(n, source, o)))
sec.command('unbind <env-name>').description('Remove a service credential binding from a compute env var')
  .option('--branch <branch>', 'branch (default: current)')
  .option('--from <compute-service>', 'target compute service, e.g. compute/api')
  .option('--json')
  .action(guard((n, o) => secretsCmd.secretsUnbind(n, o)))
sec.command('bindings').description('List service credential bindings for a compute service')
  .option('--branch <branch>', 'branch (default: current)')
  .option('--target <compute-service>', 'target compute service, e.g. compute/api')
  .option('--json')
  .action(guard((o) => secretsCmd.secretsBindings(o)))
sec.command('sources').description('List service credential sources available for binding')
  .option('--branch <branch>', 'branch (default: current)')
  .option('--json')
  .action(guard((o) => secretsCmd.secretsSources(o)))
sec.command('tree').description('Show secrets as project → branch → service → secrets').option('--json')
  .action(guard((o) => secretsCmd.secretsTree(o)))

// ---- cron (branch-scoped schedules that send one HTTP request) ----
// Every expression is evaluated in UTC and every time printed is UTC: a cron pinned to UTC does not
// keep a fixed local time, so a localised column would quietly lie across a DST boundary.
const cron = program.command('cron').description('Schedule HTTP calls on a branch — a compute service of the project, or an external URL. Expressions and every printed time are UTC')
// The repeatable --header collector, declared once: commander needs the same reducer on create and
// edit, and two copies is how they drift apart.
const headerOption = (c: Command): Command => c.option(
  '--header <name=value>',
  'request header, repeatable (split on the first = so a value may contain one). Values are encrypted at rest and are NEVER returned by a read — `cron show` lists header names only',
  (v: string, prev: string[]) => [...prev, v], [] as string[],
)
cron.command('list').description('List the branch\'s cron jobs: state, expression, next UTC run and target')
  .option('--branch <branch>', 'branch (default: current)').option('--json')
  .action(guard((o) => cronCmd.cronList(o)))
headerOption(cron.command('create <name> <expression>'))
  .description('Create a cron job. The expression is a 5-field cron expression in UTC (quote it — the shell eats the *). Name a target with --url or --service')
  .option('--url <url>', 'external target: an absolute http(s) URL')
  .option('--service <name>', "internal target: a compute service on this branch — the worker resolves its live route at send time, so a redeploy can't leave the job firing at a dead host")
  .option('--path <path>', 'request path on the --service target, leading slash (default /)')
  .option('--method <method>', 'GET or POST (default GET, or POST when --body is given)')
  .option('--body <json>', 'request body — POST only')
  .option('--timeout <ms>', 'request timeout, 1000..300000 ms; excludes cold start (the wake is timed separately)')
  .option('--branch <branch>', 'branch (default: current)').option('--json')
  .action(guard((name, expression, o) => cronCmd.cronCreate(name, expression, o)))
cron.command('show <name>').description('Show one cron job: schedule, next UTC run, target, request (header NAMES only — values are write-only), retry policy and the revision an edit is conditioned on')
  .option('--branch <branch>', 'branch (default: current)').option('--json')
  .action(guard((name, o) => cronCmd.cronShow(name, o)))
headerOption(cron.command('edit <name>'))
  .description('Change a cron job. The request is REPLACED, not merged (header values cannot be read back, so anything --header does not re-supply is dropped — the command names what it drops). Conditioned on the revision just read: a concurrent edit fails rather than clobbering')
  .option('--expression <expr>', 'new 5-field cron expression (UTC; quote it)')
  .option('--name <new-name>', 'rename the job')
  .option('--url <url>', 'external target: an absolute http(s) URL')
  .option('--service <name>', 'internal target: a compute service on this branch')
  .option('--path <path>', 'request path on the --service target (default: the path it already had)')
  .option('--method <method>', 'GET or POST')
  .option('--body <json>', 'request body — POST only')
  .option('--timeout <ms>', 'request timeout, 1000..300000 ms')
  .option('--branch <branch>', 'branch (default: current)').option('--json')
  .action(guard((name, o) => cronCmd.cronEdit(name, o)))
cron.command('pause <name>').description('Stop a cron job firing, keeping its definition and history')
  .option('--branch <branch>', 'branch (default: current)').option('--json')
  .action(guard((name, o) => cronCmd.cronPause(name, o)))
cron.command('resume <name>').description('Let a paused cron job fire again from the next tick')
  .option('--branch <branch>', 'branch (default: current)').option('--json')
  .action(guard((name, o) => cronCmd.cronResume(name, o)))
cron.command('delete <name>').description('Delete a cron job — it stops firing immediately; its run history is retained')
  .option('-y, --yes', 'required: confirm the deletion (there is no prompt, in a terminal or out of one)')
  .option('--branch <branch>', 'branch (default: current)').option('--json')
  .action(guard((name, o) => cronCmd.cronDelete(name, o)))
cron.command('run <name>').description('Trigger one run now. An EXTRA execution — the next scheduled run still happens. Sent with an Idempotency-Key minted once, so a retried request cannot fire the job twice')
  .option('--branch <branch>', 'branch (default: current)').option('--json')
  .action(guard((name, o) => cronCmd.cronRun(name, o)))
cron.command('runs <name>').description('Run history, most recent first: status, trigger, attempts, the wake/request split (a slow wake is the platform, a slow request is your endpoint) and the HTTP status')
  .option('--limit <n>', 'number of runs, 1..100 (default 20)')
  .option('--branch <branch>', 'branch (default: current)').option('--json')
  .action(guard((name, o) => cronCmd.cronRuns(name, o)))
cron.command('preview <expression>').description('Validate an expression and print its next five UTC fire times — answered by the same parser the scheduler uses. Exits 1 when the expression is invalid')
  .option('--json').action(guard((expression, o) => cronCmd.cronPreview(expression, o)))

// ---- domain (bought here, or bring your own; hostnames on compute services; DNS of bought zones) ----
const dom = program.command('domain').description('Domains: buy through InstaCloud or bring your own — attach / check / detach hostnames on compute services; DNS records of bought domains')
dom.command('search <keyword>').description('Search purchasable names with prices (a label like "myapp" or a full name like "myapp.com")')
  .option('--tlds <list>', 'comma-separated TLDs to include').option('--org <id>', "target org (default: linked project's org)").option('--json')
  .action(guard((keyword, o) => domainCmd.domainSearch(keyword, o)))
dom.command('buy <name>').description('Buy a domain — pay at the printed Stripe Checkout link. It serves nothing until you attach it (gated: domain.purchase)')
  .option('--years <n>', 'registration term in years (default 1)')
  .option('--no-open', 'print the checkout URL instead of opening a browser').option('--json')
  .action(guard((name, o) => domainCmd.domainBuy(name, o)))
dom.command('attach <hostname>').description('Point a hostname at a compute service. A domain bought here: `abc.com` binds it and its www, `api.abc.com` binds only that. A domain you own elsewhere: the DNS records to publish in your own zone are printed (gated: deploy)')
  .option('--branch <b>').option('--group <g>', "compute service (default: the branch's sole compute service)").option('--json')
  .action(guard((hostname, o) => domainCmd.domainAttach(hostname, o)))
dom.command('check <hostname>').description("A hostname's attach state — ownership TXT, routing CNAME, edge certificate, where it resolves — and what each still needs")
  .option('--branch <b>').option('--group <g>', "compute service (default: the branch's sole compute service)").option('--json')
  .action(guard((hostname, o) => domainCmd.domainCheck(hostname, o)))
dom.command('detach <hostname>').description('Detach a hostname from its compute service (gated: deploy). Bring-your-own hostnames only — a hostname under a domain bought here is moved with `insta domain attach`, which releases it from its current service')
  .option('--branch <b>').option('--group <g>', "compute service (default: the branch's sole compute service)").option('--json')
  .action(guard((hostname, o) => domainCmd.domainDetach(hostname, o)))
dom.command('list').description("Domains bought through InstaCloud in this org — a domain belongs to the org, each of its hostnames to a service")
  .option('--org <id>', "target org (default: linked project's org)").option('--json')
  .action(guard((o) => domainCmd.domainList(o)))
dom.command('status <name>').description("A bought domain's order and attach state")
  .option('--org <id>', "target org (default: linked project's org)").option('--json')
  .action(guard((name, o) => domainCmd.domainStatus(name, o)))
dom.command('delegate <domain>').description("Move a bought domain's DNS onto an InstaCloud-managed zone — the way an apex hostname gets a certificate and serves. Every record is copied first and the nameservers switch after, so serving hostnames stay up and ones that failed by delegating away revive on their own. While managed, `domain records` answers 409 for every verb (managed-zone record editing is not covered yet); `nameservers reset` is the way back (org admin; gated: domain.delegate — agent mode gates from a linked project, an unlinked --org call falls under org administration instead)")
  .option('--org <id>', "target org (default: linked project's org)").option('--json')
  .action(guard((domain, o) => domainCmd.domainDelegate(domain, o)))
const ns = dom.command('nameservers').description("Delegate a bought domain's zone to nameservers you name, or put it back on InstaCloud's registrar — for InstaCloud's own managed zone, use `insta domain delegate`")
ns.command('set <domain> <nameservers...>').description("Delegate the zone to nameservers of YOURS — they must already host it. Every hostname the domain serves stops answering, unless they are the registrar's own: the records an attach published live in the zone you are leaving. To keep hostnames serving on InstaCloud-run nameservers instead, use `insta domain delegate`")
  .option('--org <id>', "target org (default: linked project's org)").option('--json')
  .action(guard((domain, hosts, o) => domainCmd.domainNameserversSet(domain, hosts, o)))
ns.command('reset <domain>').description("Put the zone back on the registrar's own nameservers — from your own delegation or from an InstaCloud-managed zone alike; a hostname `set` took down is re-attached with `insta domain attach`, one a managed zone was serving re-verifies on its own")
  .option('--org <id>', "target org (default: linked project's org)").option('--json')
  .action(guard((domain, o) => domainCmd.domainNameserversReset(domain, o)))

const xfer = dom.command('transfer').description('Take a bought domain to another registrar — open the lock, then read the code (all three need org admin)')
xfer.command('lock <domain> <mode>').description("Open or close the registrar transfer lock (mode: on|off). ICANN's own 60-day lock on a new registration outranks it")
  .option('--org <id>', "target org (default: linked project's org)").option('--json')
  .action(guard((domain, mode, o) => domainCmd.domainTransferLock(domain, mode, o)))
xfer.command('code <domain>').description('The EPP authorization code the gaining registrar asks for — it moves nothing on its own')
  .option('--org <id>', "target org (default: linked project's org)").option('--json')
  .action(guard((domain, o) => domainCmd.domainTransferCode(domain, o)))

const rec = dom.command('records').description('DNS records of a bought domain — the zone InstaCloud holds at the registrar')
rec.command('list <domain>').description('Every record in the zone, managed ones marked')
  .option('--org <id>', "target org (default: linked project's org)").option('--json')
  .action(guard((domain, o) => domainCmd.domainRecordsList(domain, o)))
rec.command('add <domain> <type> <name> <content>').description('Add a record — type A|AAAA|CNAME|ANAME|MX|TXT|SRV|NS; name "@" for the domain itself, a label like "www", or the full hostname under it')
  .option('--ttl <seconds>', 'time to live in seconds (default 300)').option('--priority <n>', 'MX and SRV only')
  .option('--org <id>', "target org (default: linked project's org)").option('--json')
  .action(guard((domain, type, name, content, o) => domainCmd.domainRecordsAdd(domain, type, name, content, o)))
rec.command('set <domain> <id>').description('Change a record by its id (from `records list`); fields you omit keep their value')
  .option('--type <t>', 'A|AAAA|CNAME|ANAME|MX|TXT|SRV|NS').option('--name <host>', '"@" for the domain itself, a label like "www", or the full hostname under it').option('--content <value>', 'the answer').option('--ttl <seconds>', 'time to live in seconds').option('--priority <n>', 'MX and SRV only')
  .option('--org <id>', "target org (default: linked project's org)").option('--json')
  .action(guard((domain, id, o) => domainCmd.domainRecordsSet(domain, id, o)))
rec.command('remove <domain> <id>').description('Remove a record by its id (a record InstaCloud published for a live hostname is refused)')
  .option('--org <id>', "target org (default: linked project's org)").option('--json')
  .action(guard((domain, id, o) => domainCmd.domainRecordsRemove(domain, id, o)))

// logs/metrics live under each resource; the platform component is fixed by the parent. One
// registration path so the five groups cannot drift apart in flags or wording.
function addObservability(group: Command, component: 'compute' | 'db' | 'redis' | 'mysql' | 'mongodb', noun: string): void {
  group.command('metrics [service]').description(`${noun} metrics — last value per series (--json for the points)`)
    .option('--branch <b>').option('--from <unix>').option('--to <unix>').option('--step <s>').option('--json')
    .action(guard((service, o) => obs.metrics(component, service, o)))
  const logs = group.command('logs [service]').description(component === 'db'
    ? `${noun} logs (runtime; a window pages ~7 days of history)`
    : `${noun} logs (runtime by default; --deploy = machine lifecycle events)`)
    .option('--branch <b>').option('--limit <n>').option('--region <r>').option('--instance <i>').option('--json')
    .option('--from <t>', 'window start: unix seconds or ISO-8601 — pages history (~7-day retention); without a window one recent provider page (~100 lines) is returned')
    .option('--to <t>', 'window end: unix seconds or ISO-8601 (default: now)')
    .option('--since <dur>', 'relative window start, e.g. 90s, 30m, 2h, 1d (shorthand for --from now-dur)')
  if (component !== 'db') logs.option('--deploy', 'show deploy events (machine lifecycle) instead of runtime logs')
  logs.action(guard((service, o) => obs.logs(component, service, o)))
}

// `insta compute exec` needs the command verbatim after a literal `--`; split it out of argv here,
// before commander parses anything (see splitExecArgs's own comment for why `service` being
// optional makes commander unable to hold that boundary itself).
const {
  argv: computeArgv,
  command: execCommand,
  windowsFallback: execWindowsFallback,
} = computeCmd.splitExecArgs(process.argv)

// ---- compute ----
const compute = program.command('compute').description('Compute services: lifecycle (start/stop/suspend/restart/status), scale, limits, volume, always-on, exec, ssh, GitHub source, logs, metrics')
compute.command('start [service]').description('Bring a compute service online (persistent — re-enables auto-wake)')
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((service, o) => computeCmd.computeStart(service, o)))
compute.command('stop [service]').description('Take a compute service offline; traffic will NOT wake it until `start`')
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((service, o) => computeCmd.computeStop(service, o)))
compute.command('suspend [service]').description('Suspend a compute service (RAM snapshot); stays down until `start`')
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((service, o) => computeCmd.computeSuspend(service, o)))
compute.command('restart [service]').description("Restart a compute service by re-running the image it already runs against a freshly resolved env bundle — this is how a changed secret or binding reaches a running machine (env is baked into the machine at deploy time), and how a machine that is up but wedged gets cycled (`start` no-ops on one that is already started). No new image, no new spec. The service must be running: a stopped or suspended one comes back with `insta compute start`. All plans; gated: deploy — it lands configuration the same way a deploy does, so a policy denying deploys denies this too (`start`/`stop` stay ungated, and cycle a wedged machine without one). A service whose app fails to answer on its port coming back up reports that failure, and the machines are rolled back, best-effort, to the config they were serving")
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((service, o) => computeCmd.computeRestart(service, o)))
compute.command('status [service]').description("Show a compute service's desired vs. live state")
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((service, o) => computeCmd.computeStatus(service, o)))
compute.command('scale <count> [service]').description('Set a compute service same-region replica count, 1 to 10 (paid plans only)')
  .option('--region <region>', 'region to scale in (default: the service region)')
  .option('--json').option('--branch <branch>', 'branch (default: current)')
  .action(guard((count, service, o) => computeCmd.computeScale(count, service, o)))
compute.command('limits [service]').description("Show or set a compute service's resource ceiling (any plan within the free cap; raising above it needs a paid plan). --memory is the dial; cpu derives from it unless --cpu is given. Billing is actual usage — the ceiling caps what the app may burn, it is not a price")
  .option('--memory <size>', 'memory ceiling, e.g. 512mb or 1gb').option('--cpu <n>', 'vCPU ceiling override (provider sizes: 1, 2, 4, 6, 8)')
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((service, o) => computeCmd.computeLimits(service, o)))
compute.command('always-on <mode> [service]').description('Set a compute service always-on (mode: on|off). on = machines never scale to zero (the default for new compute services); off = scale-to-zero. All plans; billing is actual usage either way')
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((mode, service, o) => computeCmd.computeAlwaysOn(mode, service, o)))
compute.command('ssh [service]')
  .description("Issue a short-lived SSH certificate for a compute service and print the command that uses it -- this command does NOT open the session itself, it makes `ssh` work. `--setup` does the one-time work: it generates a dedicated key under ~/.insta/ssh (your existing keys are never touched), has the platform sign a SHORT-LIVED certificate for it, adds one @cert-authority line to ~/.ssh/known_hosts so every region is trusted without per-node fingerprint prompts, and writes an ssh_config block AT THE TOP of ~/.ssh/config giving each compute service the alias `<service>.insta`. After that it is plain `ssh api.insta`, scp and -L: the block renews that alias's certificate for you while OpenSSH parses the config. Needs an interactive login -- API keys are refused; use `insta compute exec` for one-shot commands from CI")
  .option('--setup', 'do the one-time client setup as well as issuing a certificate')
  .option('--ensure-cert <alias>', 'renew the certificate for an alias such as api.insta if it is close to expiry, then exit (used by the ssh_config hook; silent by design)')
  .option('-b, --branch <branch>', 'branch (default: linked)')
  .option('--json', 'machine-readable output')
  .action(guard((service, o) => computeCmd.computeSSH(service, o)))

const execCmd = compute.command('exec [service]').description("Run a one-shot command inside a compute service's machine (`insta compute exec [service] -- <command> [args…]`) — no interactive shell/PTY: `command` is argv, no shell is invoked (use [\"sh\", \"-c\", \"...\"] for shell features). Wakes the machine first if it's scaled to zero — expect a few seconds of latency, billed as uptime, not an error. Exits with the remote command's own exit code (agents rely on this)")
  .action(guard((service, o) => computeCmd.computeExec(service, execCommand, o, { windowsFallback: execWindowsFallback })))
// Declared from the same list splitExecArgs uses to find where the CLI's own arguments stop, so a
// new option cannot reach the CLI surface while the split still reads it as part of the command.
for (const [flags, description] of computeCmd.EXEC_OPTIONS) execCmd.option(flags, description)
compute.command('repo [service]').description('Show what a compute service deploys from: the image it runs, or the GitHub repository — owner/repo, the branch it builds, root directory, which paths a push must change to redeploy it, and whether pushes redeploy it at all')
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((service, o) => githubCmd.computeRepo(service, o)))
compute.command('connect-repo <owner/repo> [service]').description("Connect a GitHub repository to an EXISTING compute service: the repo is built (its Dockerfile, or nixpacks when there is none) and deployed into that service, and every later push to the tracked repository branch redeploys it. The repo must be one your own GitHub account can reach through the InstaCloud App, or be public; the CLI opens GitHub for device-code authorization and App installation or configuration when needed, then waits for repository access and continues. URLs are also printed for remote terminals; --json requires access to be ready. Build and start commands come from detection and cannot be set. Connecting again replaces the service's current source")
  .option('--public', 'the repo is public and no GitHub App installation is needed (deploys are manual; pushes cannot redeploy)')
  .option('--root-dir <dir>', 'the directory of the repo to build (a monorepo with several deployable directories lists them and exits 1 without it)')
  .option('--repo-branch <name>', "the repository branch to build (default: the repo's default branch)")
  .option('--no-auto-deploy', 'do not rebuild on pushes; redeploy by connecting again or from the console')
  .option('--watch-paths <patterns>', "only redeploy when a push changes a matching path — a comma-separated list of gitignore patterns relative to the REPOSITORY ROOT, not to --root-dir, e.g. 'apps/web/**,packages/ui/**' (quote them, or the shell expands the *)")
  .option('--port <n>', 'port the app listens on (default: detected)')
  .option('--branch <branch>', 'branch (default: current) — the environment the service is on')
  .option('--json').action(guard((ref, service, o) => githubCmd.computeConnectRepo(ref, service, o)))
compute.command('watch-paths [service]').description("Show or change which paths make a push redeploy a compute service. No flag prints them. --set narrows to a comma-separated list of gitignore patterns matched against paths relative to the REPOSITORY ROOT (not to the service's root directory), so a monorepo push that touched nothing on the list leaves this service alone — unless GitHub cannot report what a push changed (a force-push, or a comparison of 300 or more files, where its list stops being complete), in which case it deploys rather than risk skipping a real change. --clear removes the filter: every push that deploys this service deploys it again. Neither rebuilds the service — this changes which pushes deploy, not what a deploy builds")
  .option('--set <patterns>', "the patterns, comma-separated, e.g. 'apps/web/**,packages/ui/**' — quote them, or the shell expands the *; a leading ! excludes, under git's rule that a path cannot be re-included once an earlier pattern took its directory")
  .option('--clear', 'remove the filter: every push that deploys this service deploys it again')
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((service, o) => githubCmd.computeWatchPaths(service, o)))
compute.command('disconnect-repo [service]').description('Disconnect the GitHub repository from a compute service. The service keeps running its current image; pushes no longer deploy it, and its build history stays')
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((service, o) => githubCmd.computeDisconnectRepo(service, o)))
compute.command('start-command [service]').description('Show or stage a compute startup command for the next deployment. Runs through sh -c; --clear restores the image default. Stage the volume path and command before deploying. CLI secrets writes redeploy immediately; use Console to combine variables, path and command in one deployment.')
  .option('--set <command>', 'startup command to use on the next deploy')
  .option('--clear', 'use the image default command on the next deploy')
  .option('--json').option('--branch <branch>', 'branch (default: current)')
  .action(guard((service, o) => computeCmd.computeStartCommand(service, o)))
compute.command('volume [service]').description("Show, attach, grow, remount, or delete a compute service's persistent volume. --mount-path alone stages an existing volume path change, pending until deploy or restart; an unchanged normalized path is a no-op readback. No flag: print size, mount path, and the plan cap (any plan). --size on a volumeless service ATTACHES one (any plan up to its own plan cap — 10Gi free, 50Gi paid by default — which is also what a disk with no size named is born at; a size above the free cap is paid; the disk mounts at --mount-path (default /data) on the next deploy); on a volume-bearing one it grows (paid plans; grow-only — a provisioned disk cannot shrink). --delete DESTROYS the disk and ALL its data immediately (no detach, no undo; billing stops now, and suspend fast-wake + scale-out return). Billing is actual data stored — the size is a cap, not a price")
  .option('--mount-path <path>', 'configure mount path; existing volume changes apply on the next deploy (restarts the service)')
  .option('--size <gi>', 'new size in whole Gi, e.g. 10 (must be ≥ the current size)')
  .option('--delete', 'destroy the volume and ALL its data (irreversible; download anything you need first)')
  .option('--json').option('--branch <branch>', 'branch (default: current)').action(guard((service, o) => computeCmd.computeVolume(service, o)))
addObservability(compute, 'compute', 'compute')

// ---- postgres ----
const pg = program.command('postgres').description('Postgres services: connection string, psql, stats, resource ceiling, volume, always-on, logs, metrics')
pg.command('url [service]').description('Print the postgres connection string (DSN) — bare on stdout for piping, e.g. `psql "$(insta postgres url)"` (gated: secrets.read). Provider credentials are not in `insta secrets` — this is the command that yields the DSN')
  .option('--json').option('--branch <branch>', 'branch (default: current)')
  .action(guard((service, o) => pgCmd.dbUrl(service, o)))
pg.command('connect [service]').description("Open an interactive psql session on the postgres service (needs psql on PATH; gated: secrets.read). A suspended instance wakes on connect — the first prompt can take a few seconds. Exits with psql's own exit code")
  .option('--branch <branch>', 'branch (default: current)')
  .action(guard((service, o) => pgCmd.dbConnect(service, o)))
pg.command('stats [service]').description("Postgres stats snapshot: connections vs the server's max (active count), cache hit rate, database size. insta-db-backed services answer without waking a suspended instance")
  .option('--json').option('--branch <branch>', 'branch (default: current)')
  .action(guard((service, o) => pgCmd.dbStats(service, o)))
pg.command('limits [service]').description("Show or set a postgres service's resource ceiling (any plan within the free cap, paid above it; insta-db-backed only). Moves both directions")
  .option('--cpu <n>', 'vCPU ceiling, e.g. 2 or 2500m').option('--memory <size>', 'memory ceiling, e.g. 4Gi')
  .option('--json').option('--branch <branch>', 'branch (default: current)')
  .action(guard((service, o) => pgCmd.dbLimits(service, o)))
pg.command('volume [service]').description("Show or grow a postgres service's provisioned volume (block disk; insta-db-backed only). No --size: print size and the plan cap (any plan). --size grows it (paid plans; grow-only — a provisioned disk cannot shrink). Billing is actual data stored — the size is a cap, not a price")
  .option('--size <gi>', 'new size in whole Gi, e.g. 10 (must be ≥ the current size)')
  .option('--json').option('--branch <branch>', 'branch (default: current)')
  .action(guard((service, o) => pgCmd.dbVolume(service, o)))
pg.command('always-on <mode> [service]').description('Set a postgres service always-on (mode: on|off). on = instance stays warm, no cold starts; off = default scale-to-zero (idle instance suspends; first connection cold-starts). insta-db-backed services only')
  .option('--json').option('--branch <branch>', 'branch (default: current)')
  .action(guard((mode, service, o) => pgCmd.dbAlwaysOn(mode, service, o)))
addObservability(pg, 'db', 'postgres')

// ---- redis / mysql / mongodb (managed Fly databases) ----
for (const type of ['redis', 'mysql', 'mongodb'] as const) {
  const g = program.command(type).description(`Managed ${type} services: query, status, resource ceiling, volume, always-on, logs, metrics`)
  const query = g.command('query <service> [args...]').description(type === 'redis'
    ? 'Run a redis command against the service via the console exec API — a pre-tokenized argv, e.g. `GET mykey`'
    : `Run one quoted ${type} statement against the service via the console exec API`)
    .option('--branch <branch>', 'branch (default: current)').option('--json')
  if (type === 'mongodb') query.option('--database <db>', 'the database to run against (default admin)')
  query.action(guard((service, args, o) => dbQueryCmd.dbQuery(service, args, o, undefined, type)))
  g.command('status [service]').description(`A ${type} service's live runtime health: healthy | crashed | starting | standby (scaled to zero, wakes on request — normal) | none | unknown`)
    .option('--json').option('--branch <branch>', 'branch (default: current)')
    .action(guard((service, o) => managedDb.managedStatus(type, service, o)))
  g.command('limits [service]').description(`Show or set a ${type} service's resource ceiling (any plan within the free cap; raising above it needs a paid plan). --memory is the dial; cpu derives from it unless --cpu is given. Billing is actual usage — the ceiling caps what the database may burn, it is not a price`)
    .option('--memory <size>', 'memory ceiling, e.g. 512mb or 1gb').option('--cpu <n>', 'vCPU ceiling override (provider sizes: 1, 2, 4, 6, 8)')
    .option('--json').option('--branch <branch>', 'branch (default: current)')
    .action(guard((service, o) => computeCmd.serviceLimits(type, service, o)))
  g.command('volume [service]').description(`Show, attach, or grow a ${type} service's data volume (the image's data directory). No flag: size and the plan cap (any plan). --size on a volumeless service ATTACHES one (any plan up to its own plan cap; a size above the free cap is paid); on a volume-bearing one it grows (paid plans; grow-only once attached — a provisioned disk cannot shrink). A managed database's volume cannot be deleted — remove the service instead. Billing is actual data stored — the size is a cap, not a price`)
    .option('--size <gi>', 'new size in whole Gi, e.g. 10 (must be ≥ the current size)')
    .option('--json').option('--branch <branch>', 'branch (default: current)')
    .action(guard((service, o) => computeCmd.serviceVolume(type, service, o)))
  g.command('always-on <mode> [service]').description(`Set a ${type} service always-on (mode: on|off). on = machines never scale to zero; off = scale-to-zero. Billing is actual usage either way`)
    .option('--json').option('--branch <branch>', 'branch (default: current)')
    .action(guard((mode, service, o) => computeCmd.serviceAlwaysOn(type, mode, service, o)))
  addObservability(g, type, type)
}

// ---- storage (bucket objects + access mode) ----
const storage = program.command('storage').description("Storage services: browse, download, delete bucket objects; set the bucket's access mode")
storage.command('list').description("List the bucket's objects. S3 filters by prefix only — there is no substring search")
  .option('--prefix <p>', 'only keys starting with this prefix (applied server-side)')
  .option('--cursor <c>', 'continue from the nextCursor a previous page printed')
  .option('--limit <n>', 'page size, 1..1000 (default 100)')
  .option('--service <name>', 'storage service (default: the sole one on the branch)')
  .option('--branch <b>', 'branch (default: current)').option('--json')
  .action(guard((o) => storageCmd.storageList(o)))
storage.command('get <key>').description('Download one object to disk through a short-lived presigned URL (bytes come straight from the provider)')
  .option('-o, --output <file>', "output file (default: the key's last segment)")
  .option('--service <name>', 'storage service (default: the sole one on the branch)')
  .option('--branch <b>', 'branch (default: current)')
  .option('--json', 'print the presigned URL + expiry instead of downloading')
  .action(guard((key, o) => storageCmd.storageGet(key, o)))
storage.command('delete <key>').description('DELETES one object from the bucket immediately — no undo, and an already-gone key still reports success (gated: storage.delete)')
  .option('--service <name>', 'storage service (default: the sole one on the branch)')
  .option('--branch <b>', 'branch (default: current)').option('--json')
  .action(guard((key, o) => storageCmd.storageDelete(key, o)))
storage.command('set-access <access>').description("Set the bucket's access mode — public (anonymous public-read) or private (the default)")
  .option('--service <name>', 'storage service (default: the sole one on the branch)')
  .option('--branch <b>', 'branch (default: current)').option('--json')
  .action(guard((access, o) => storageCmd.storageSetAccess(access, o)))

// ---- build (pre-push verification — local, offline, deploys nothing) ----
const buildCmd = program.command('build [dir]').description('Verify a source directory would build before deploying: detection plan + the Dockerfile (yours, or the one nixpacks would generate server-side) + static checks. Local and offline — no login needed, nothing pushed. Exit 1 when the verdict is failed')
  .option('--explain', 'include the Dockerfile content in the output')
  .option('--port <p>', 'port the app listens on (else the Dockerfile EXPOSE)')
  .option('--json')
  .action(guard((dir, o) => build(dir, o)))
// commander 12 defaults allowExcessArguments to true, so a mistyped subcommand (e.g. `build lgs`)
// would otherwise be taken as the [dir] positional and run this group's own action instead of failing.
buildCmd.allowExcessArguments(false)
buildCmd.command('logs <build-id>').description('Read source-build output for a deploy operation or GitHub build')
  .option('--source <source>', 'archive or github', 'archive').option('--follow', 'poll new output until the build ends').option('--json')
  .action(guard((id, opts) => buildLogs(id, opts)))

// ---- deploy ----
program.command('deploy [dir]').description('Deploy a source directory (built remotely; on insta-compute a Dockerfile is optional and nixpacks detects the runtime) or a prebuilt --image to a branch compute group')
  .option('--image <url>', 'prebuilt container image to deploy (instead of a source dir)').option('--branch <b>').option('--group <g>').option('--port <p>')
  .option('--websocket', 'run a WebSocket app (larger guest + connection-based concurrency)')
  .option('--replace-source', 'the service deploys from a connected GitHub repo: switch it to this image and remove the repo connection (admin); without it such a deploy is refused')
  .option('--json', 'print the deploy result as JSON (build progress goes to stderr)')
  .action(guard((dir, o) => deploy(dir, o)))

// ---- run (per-request secret injection — nothing written to disk) ----
program.command('run <cmd> [args...]').description('Run a command with the branch credential bundle injected into its environment (no .env written)')
  .option('--branch <b>', 'branch bundle to inject (default: linked branch)')
  .option('--service <type/name>', "inject one compute service's own slice of the branch bundle, e.g. compute/api — the unambiguous read when several services define the same name (NOT the container's env: it also carries the branch's provider credentials, which a container gets only where bound)")
  .option('--ignore-collisions', 'run even when several services define the same name; every such name is REMOVED from the child environment (never inherited from your shell)')
  .passThroughOptions().allowUnknownOption()
  .action(guard((cmd, args, o) => runCmd.run([cmd, ...(args ?? [])], o)))

// ---- templates (registry, local insta.template.yaml, or a GitHub URL) ----
const tpl = program.command('template').description('Browse and deploy app templates (registry, a local dir, or a GitHub URL)')
tpl.command('list').description('List templates in the platform registry').option('--json').action(guard((o) => template.templateList(o)))
tpl.command('info <code>').description('Show a template: version, upstream pin, services, and its required/optional variables')
  .option('--json').action(guard((code, o) => template.templateInfo(code, o)))
tpl.command('deploy <code-or-dir-or-url>').description('Deploy a template onto a branch — a registry code, a local directory containing insta.template.yaml (a path-looking target is always read as a directory), or a github.com URL (https://github.com/<owner>/<repo>[/tree/<ref>[/<dir>]]) whose manifest is fetched with your own git credentials. Missing required variables are prompted for on a terminal; generator-backed (secret:N) and defaulted ones are resolved by the platform')
  .option('--branch <b>', 'target branch (default: current)')
  .option('--region <region>', 'region for every service the template creates, e.g. us-east (see `insta config regions`)')
  .option('--set <NAME=value>', 'set a template variable (repeatable)', (v: string, prev: string[]) => [...prev, v], [] as string[])
  .option('-y, --yes', 'non-interactive: missing required variables fail with a --set list instead of prompting')
  .option('--json')
  .action(guard((target, o) => template.templateDeploy(target, o)))

// ---- billing ----
const bill = program.command('billing').description('Billing: current cycle overview (bare), subscribe to a tier, Stripe portal, usage by dimension')
  .option('--org <id>', 'target org (default: linked project\'s org)').option('--json')
  .action(guard((o) => billing(o)))
// commander 12 defaults allowExcessArguments to true, so a mistyped/retired subcommand (e.g.
// `billing upgrade pro`) would otherwise silently run the overview action instead of failing.
bill.allowExcessArguments(false)
bill.command('subscribe <tier>').description('Subscribe the org to a paid tier (pro|team) via Stripe Checkout')
  .option('--org <id>').option('--no-open', 'print the URL instead of opening a browser').option('--json')
  .action(guard((tier, o) => billingUpgrade(tier, o)))
bill.command('portal').description('Open the Stripe Customer Portal (change plan / card / cancel)')
  .option('--org <id>').option('--no-open', 'print the URL instead of opening a browser').option('--json')
  .action(guard((o) => billingPortal(o)))
bill.command('usage').description('Usage for the current billing cycle by billing dimension (org by default; --proj for one project)')
  .option('--from <unix>').option('--to <unix>').option('--proj [id]', 'show one project (the linked one, or a given id) instead of the whole org').option('--json')
  .action(guard((o) => obs.usage(o)))

// `agent setup` and its hidden alias `setup agent` declare their options from ONE list, so a flag
// added to the canonical command cannot be missing from the one-liner the console prints.
function withSetupAgentOptions(cmd: Command): Command {
  return cmd
    .option('-y, --yes', 'non-interactive')
    .option('--env <prod|staging>', 'deployment to set this machine up for (default: prod — switches and persists, like `insta env use`)')
    .option('--mcp-token', 'register Claude Code with a minted insta_ API token instead of OAuth (requires login and token-creation permission)')
    .option('--project <id>', 'also link this directory to an existing project after setup (flows through login first if needed)')
    .option('--create [name]', 'also create a new project and link this directory after setup (default name: this directory; mutually exclusive with --project)')
    .action(guard((o) => setup.setupAgent(o)))
}

// ---- agent (this machine's coding agents + the project's agent governance) ----
const agent = program.command('agent').description('Agents: set up this machine, the project manifest, access policy, approvals (HITL), the local credential audit, the event timeline')
withSetupAgentOptions(agent.command('setup').description('Install the insta CLI (if missing), the insta skill for all coding agents, and the MCP server — targets production; pass --env staging for the staging deployment'))
agent.command('manifest').description('Print an agent-legible view of the project environments').option('--json').action(guard((o) => manifest(o)))
const agentPol = agent.command('policy').description('Project agent access policy')
agentPol.command('get').option('--json').action(guard((o) => agentPolicy.get(o)))
agentPol.command('set <mode>').description('full-access | read-only | branch-specific (resets rules; customize comes from `rule set`)')
  .option('--json').action(guard((mode, o) => agentPolicy.set(mode, o)))
agentPol.command('protect-branch <branch>').option('--json').action(guard((branch, o) => agentPolicy.protect(branch, true, o)))
agentPol.command('unprotect-branch <branch>').option('--json').action(guard((branch, o) => agentPolicy.protect(branch, false, o)))
agentPol.command('rule').command('set <action> <decision>').description('Set an unprotected-branch rule (allow | deny | approve); moves the policy to customize')
  .option('--json').action(guard((action, decision, o) => agentPolicy.rule(action, decision, o)))
agentPol.command('revoke-sessions').description('Revoke ALL CLI agent sessions for this project')
  .option('--json').action(guard((o) => agentPolicy.revoke(o)))
const ap = agent.command('approvals').description('Governance approvals (HITL)')
ap.command('list').option('--status <s>', 'pending|granted|denied|consumed').option('--json').action(guard((o) => govern.approvalsList(o)))
ap.command('approve <id>').option('--json').action(guard((id, o) => govern.approvalsApprove(id, o)))
ap.command('deny <id>').option('--json').action(guard((id, o) => govern.approvalsDeny(id, o)))
const ob = agent.command('observe').description('Local credential-audit hook')
ob.command('install').description('Install the PostToolUse hook into this project').action(guard(() => observe.observeInstall()))
ob.command('uninstall').action(guard(() => observe.observeUninstall()))
ob.command('report').description('Render the local credential audit').option('--json').action(guard((o) => observe.observeReport(o)))
ob.command('sync').description('Upload findings into the project timeline').action(guard(() => observe.observeSync()))
agent.command('events').description('Show the audit + agent-event timeline').option('--branch <b>').option('--limit <n>').option('--json').action(guard((o) => govern.events(o)))

// ---- config (this machine's CLI configuration) ----
const cfg = program.command('config').description('CLI configuration: register the remote MCP server with coding agents, list regions, auto-update')
cfg.command('install-mcp').description('Register the remote MCP server with coding agents (default: Claude Code + all detected)')
  .option('--agent <slug>', 'one agent: claude-code, cursor, codex, opencode, copilot, factory-droid')
  .option('--mcp-token', 'claude-code only: minted insta_ API token instead of OAuth (requires login and token-creation permission)')
  .action(guard((o) => mcp.mcpInstall(o)))
cfg.command('regions').description('List regions available for postgres/compute services').option('--json').action(guard((o) => regions.regionsList(o)))
cfg.command('autoupdate [mode]').description('Show or set auto-update: on | off (default: on while pre-1.0)').action(guard((mode) => selfUpdate.autoupdate(mode)))

// ---- setup (hidden compatibility alias of `agent setup`) ----
// `npx -y insta@latest setup agent [--project <id>]` is printed by the console, the landing page
// and third-party docs; it must keep working on every release. Permanent, like `services|svc`;
// hidden so the canonical `agent setup` is the only one help advertises.
const setupCompat = program.command('setup', { hidden: true }).description('Compatibility alias: `insta setup agent` is `insta agent setup`')
withSetupAgentOptions(setupCompat.command('agent').description('Alias of `insta agent setup`, kept for the console one-liner'))

// ---- feedback (agent + human hurdle reports → the InstaCloud team) ----
program.command('feedback')
  .description('Report an InstaCloud-side hurdle (bug / missing feature / friction) to the InstaCloud team — about the insta toolkit itself, NEVER about the app you are building. Works logged-out and unlinked.')
  .option('--type <type>', `what kind of hurdle: ${feedbackCmd.TYPES.join(' | ')}`)
  .option('--component <component>', `which part of the toolkit: ${feedbackCmd.COMPONENTS.join(' | ')}`)
  .option('--title <title>', 'one-line summary (≤200 chars)')
  .option('--detail <text>', 'what happened vs what you expected (≤4000 chars)')
  .option('--file <path>', 'read the detail from a file instead of --detail')
  .option('--area <area>', 'product area, free text: deploy, branch, secrets, db, storage, compute, governance, billing, …')
  .option('--command <cmd>', 'the insta command that hit the issue')
  .option('--error <text>', 'error output (redacted + truncated locally before sending)')
  .option('--expected <text>', 'what the docs/skill said should happen')
  .option('--workaround <text>', 'what you did instead, if anything worked')
  .option('--doc <ref>', 'doc or skill file that led you here (for stale-instruction reports)')
  .option('--severity <severity>', `${feedbackCmd.SEVERITIES.join(' | ')} (default: minor)`)
  .option('--json')
  .action(guard((o) => feedbackCmd.feedback(o)))

// ---- self-update ----
program.command('upgrade').description('Update the insta CLI to the latest release (binary or npm install)')
  .action(guard(() => selfUpdate.upgrade(cliVersion())))
program.command('__update-check', { hidden: true }).action(guard(() => selfUpdate.backgroundCheck(cliVersion())))
// The ssh_config renewal hook. Hidden, and named with the `__` prefix that
// trackCommand skips, because OpenSSH runs it while PARSING the config on EVERY
// ssh/scp/`ssh -G`/IDE connection: a telemetry round trip here would sit on the
// critical path of every ordinary ssh.
program.command('__ssh-ensure-cert <alias>', { hidden: true })
  .action(guard((alias: string) => computeCmd.ensureCertForAlias(alias)))

// `--api-url` reaches every command, hidden from each command's own help (the root documents it
// once). It must be declared per command: positional-options mode matches the root's options only
// BEFORE the subcommand name, so `insta compute status --api-url X` is legal only if `status` knows
// the flag. `login` keeps its own copy (that one persists the URL). `compute exec` is skipped:
// splitExecArgs reads argv ahead of commander and does not know this option takes a value — for
// exec, pass it at the root: `insta --api-url X compute exec …` (execCommandIndex skips it there).
function addApiUrlEverywhere(cmd: Command): void {
  for (const sub of cmd.commands) {
    if (!(cmd.name() === 'compute' && sub.name() === 'exec') && !sub.options.some((o) => o.long === '--api-url')) {
      sub.addOption(new Option('--api-url <url>').hideHelp())
    }
    addApiUrlEverywhere(sub)
  }
}
addApiUrlEverywhere(program)

selfUpdate.maybeUpdate(cliVersion(), process.argv)
program.parseAsync(computeArgv)
