/** `hyprscope` command line: read-only observation of a running Hyprland session. */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { ErrorCode, HyprscopeError } from './errors.ts'
import { baselinePaths, readBaseline } from './compat/baseline.ts'
import { compareEffective, measureEffective } from './compat/staleness.ts'
import { hashDesktopConfig } from './desktop/hash.ts'
import { CAPABILITY_IDS, capabilityLevel } from './compat/catalog.ts'
import type { CapabilityId, CapabilityLevel } from './compat/types.ts'
import { EventStream } from './events.ts'
import * as format from './format.ts'
import { hyprctlJson } from './hyprctl.ts'
import { readLockState } from './lock.ts'
import { capture, defaultCapturePath, parseRegion, preflightCaptureOutput } from './screenshot.ts'
import { captureToplevel, listToplevels, type Toplevel } from './toplevel.ts'
import { listInstanceDirs } from './session.ts'
import { parseDesktopTarget, resolveTarget } from './desktop/target.ts'
import type { DesktopTarget, ResolvedTarget } from './desktop/types.ts'
import {
  describeIsolation, normalizeClient, normalizeLayers, normalizeMonitor, normalizeWorkspace, readActive, readState,
} from './state.ts'
import type {
  Client, DesktopState, DoctorReport, LayerSurface, Monitor, RawClient, RawCursor, RawLayers, RawMonitor,
  RawStatus, RawVersion, RawWorkspace, Session, Workspace,
} from './types.ts'
import { probeBinaryPath, probeWaylandGlobals } from './wayland.ts'

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

const USAGE = `hyprscope — Hyprland desktop observation and consent-gated control

Usage: hyprscope <command> [options]
       hyprscope control <command> [options]
       hyprscope message <command> [options]

Commands:
  doctor        Probe discovery, compositor, and observation capabilities
  state         Snapshot of active focus, monitors, workspaces, clients, layers
  active        Active window and workspace
  clients       Windows known to the compositor
  workspaces    Workspaces
  monitors      Monitors and geometry
  layers        Layer-shell surfaces (bars, launchers, wallpaper)
  cursor        Pointer position in global layout coordinates
  screenshot    Capture a PNG of the layout, one monitor, a region, or one window
  events        Stream compositor events
  control       Lease-gated control surface (run "hyprscope control --help")
  message       Desktop message composer and annotation overlay for a DSH Host (run "hyprscope message --help")

Options:
  --json                 Machine-readable output
  --desktop <target>     user (default), agent, or external
  --signature <sig>      Target a specific Hyprland instance
  --runtime-dir <dir>    Override XDG_RUNTIME_DIR
  --timeout <ms>         Per-operation timeout (default 5000)
  -h, --help             Show this help
  -v, --version          Show the version

Screenshot options:
  --output <path>        Destination PNG path (default: $XDG_CACHE_HOME/hyprscope)
  --monitor <name>       Capture one output
  --region <x,y,w,h>     Capture a region in global layout coordinates
  --window-id <id>       Capture one window by Hyprland address (0x…) or toplevel identifier
  --window-app <class>   Capture one window by application id, even off-screen
  --window-title <text>  Capture one window by exact title, even off-screen
  --allow-locked         Permit capture when the session reports a lock

Event options:
  --match <regex>        Only report events whose "name:data" matches
  --once                 Exit after the first match (exit 1 when the timeout expires first)
  --count <n>            Exit after n matching events

Run "hyprscope message --help" for the desktop-message commands. They write a
message and start a Quickshell overlay, but they never change the desktop.
`

/** Parsed command line. */
export interface CliOptions {
  json: boolean
  once: boolean
  allowLocked: boolean
  help: boolean
  version: boolean
  signature?: string
  runtimeDir?: string
  desktop?: string
  timeoutMs?: number
  output?: string
  monitor?: string
  region?: string
  windowId?: string
  windowApp?: string
  windowTitle?: string
  match?: string
  count?: number
}

/** Output targets for one run. */
export interface Io {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
}

/** Options that consume the next argument. */
const VALUE_OPTIONS: Record<string, keyof CliOptions> = {
  '--signature': 'signature', '--runtime-dir': 'runtimeDir', '--desktop': 'desktop', '--timeout': 'timeoutMs',
  '--output': 'output', '--monitor': 'monitor', '--region': 'region', '--match': 'match', '--count': 'count',
  '--window-id': 'windowId', '--window-app': 'windowApp', '--window-title': 'windowTitle',
}

/** Options that are pure switches. */
const FLAG_OPTIONS: Record<string, keyof CliOptions> = {
  '--json': 'json', '--once': 'once', '--allow-locked': 'allowLocked', '--help': 'help', '--version': 'version',
}

const COMMANDS = [
  'doctor', 'state', 'active', 'clients', 'workspaces', 'monitors', 'layers', 'cursor', 'screenshot', 'events',
] as const

/** Commands that exist only under the `control` surface. */
const CONTROL_COMMANDS = new Set([
  'run', 'ops', 'status', 'panic', 'install-bind', 'uninstall-bind', 'baseline', 'desktop',
])

/**
 * Build a usage failure.
 * @param message Reason.
 * @returns `USAGE` failure.
 */
function usage(message: string): HyprscopeError {
  return new HyprscopeError(ErrorCode.USAGE, message)
}

/**
 * Parse command line arguments without a dependency.
 * @param argv Arguments after the program name.
 * @returns Parsed input.
 */
export function parseArgs(argv: string[]): { options: CliOptions; command: string | undefined; args: string[] } {
  const options: CliOptions = { json: false, once: false, allowLocked: false, help: false, version: false }
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '-h') { options.help = true; continue }
    if (argument === '-v') { options.version = true; continue }
    const separator = argument.startsWith('--') ? argument.indexOf('=') : -1
    const name = separator > 0 ? argument.slice(0, separator) : argument
    const inline = separator > 0 ? argument.slice(separator + 1) : undefined
    const flag = FLAG_OPTIONS[name]
    if (flag !== undefined) {
      if (inline !== undefined) throw usage(`${name} takes no value`)
      ;(options as unknown as Record<string, unknown>)[flag] = true
      continue
    }
    const valueKey = VALUE_OPTIONS[name]
    if (valueKey !== undefined) {
      const value = inline ?? argv[++index]
      if (value === undefined || (inline === undefined && value.startsWith('-'))) {
        throw usage(`Expected a value after ${name}`)
      }
      ;(options as unknown as Record<string, unknown>)[valueKey] = value
      continue
    }
    if (argument.startsWith('-')) throw usage(`Unknown option ${argument}`)
    positional.push(argument)
  }
  if (typeof options.timeoutMs === 'string') {
    const timeout = Number.parseInt(options.timeoutMs, 10)
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw usage('--timeout expects a positive integer in milliseconds')
    options.timeoutMs = timeout
  }
  if (typeof options.count === 'string') {
    const count = Number.parseInt(options.count, 10)
    if (!Number.isSafeInteger(count) || count <= 0) throw usage('--count expects a positive integer')
    options.count = count
  }
  return { options, command: positional[0], args: positional.slice(1) }
}

/**
 * Write one value, either as JSON or through a human renderer.
 * @param io Output targets.
 * @param value Value to print.
 * @param json Whether JSON was requested.
 * @param render Human renderer.
 */
function print<T>(io: Io, value: T, json: boolean, render: (value: T) => string): void {
  io.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${render(value)}\n`)
}

/** One candidate window for an ambiguous `--window-app`/`--window-title` selector. */
export interface WindowCandidate {
  /** Foreign-toplevel identifier the capture helper accepts. */
  identifier: string
  /** Hyprland address (`0x…`); null when no client record matched the toplevel. */
  address: string | null
  appId: string
  /** Workspace id; null when no client record matched the toplevel. */
  workspace: number | null
  title: string
  /** Whether it sits on the active workspace; null when the active workspace is unknown. */
  active: boolean | null
}

/**
 * Pair selector matches with client records and order them deterministically.
 *
 * The capture helper reports foreign toplevels, while addresses, workspaces and
 * the active workspace come from `hyprctl`. Ordering is by workspace id, then
 * address, then identifier, so an ambiguity report is stable across runs.
 * @param matches Toplevels the selector matched.
 * @param clients Client records from `hyprctl clients`.
 * @param activeWorkspaceId Active workspace id, or null when it could not be read.
 * @returns Candidates in deterministic order.
 */
export function windowCandidates(
  matches: Toplevel[], clients: RawClient[], activeWorkspaceId: number | null,
): WindowCandidate[] {
  const byStableId = new Map<string, RawClient>()
  for (const client of clients) {
    if (typeof client.stableId === 'string' && client.stableId !== '') byStableId.set(client.stableId, client)
  }
  return matches.map(match => {
    const client = byStableId.get(match.identifier)
    const address = typeof client?.address === 'string' && client.address !== '' ? client.address : null
    const workspace = typeof client?.workspace?.id === 'number' ? client.workspace.id : null
    return {
      identifier: match.identifier,
      address,
      appId: match.appId,
      workspace,
      title: match.title,
      active: activeWorkspaceId === null ? null : workspace === activeWorkspaceId,
    }
  }).sort((left, right) => {
    const leftWorkspace = left.workspace ?? Number.MAX_SAFE_INTEGER
    const rightWorkspace = right.workspace ?? Number.MAX_SAFE_INTEGER
    if (leftWorkspace !== rightWorkspace) return leftWorkspace - rightWorkspace
    const leftAddress = (left.address ?? left.identifier).toLowerCase()
    const rightAddress = (right.address ?? right.identifier).toLowerCase()
    if (leftAddress !== rightAddress) return leftAddress < rightAddress ? -1 : 1
    return left.identifier < right.identifier ? -1 : left.identifier > right.identifier ? 1 : 0
  })
}

/**
 * Render one stable line per ambiguous selector candidate.
 * @param candidates Candidates in deterministic order.
 * @returns Human-readable lines.
 */
export function renderWindowCandidates(candidates: WindowCandidate[]): string[] {
  return candidates.map(candidate => {
    const address = candidate.address ?? candidate.identifier
    const workspace = candidate.workspace === null ? 'workspace unknown' : `workspace ${candidate.workspace}`
    const state = candidate.active === null
      ? 'active workspace unknown'
      : candidate.active ? 'on active workspace' : 'off-screen'
    return `  - ${address}  ${candidate.appId}  ${workspace}  title ${JSON.stringify(candidate.title)}  ${state}`
  })
}

/**
 * Resolve a screenshot window selector to a foreign-toplevel identifier.
 *
 * `--window-id` accepts a Hyprland address (`0x…`), which is translated through
 * `hyprctl clients` into the window's stable id, or a foreign-toplevel identifier
 * directly. The other selectors match the compositor's own toplevel list, so the
 * window does not have to be visible on the active workspace.
 * @param session Discovered session.
 * @param options Parsed command line.
 * @returns Identifier the capture helper accepts.
 */
export async function resolveWindowIdentifier(session: Session, options: CliOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 5000
  if (options.windowId !== undefined) {
    const wanted = options.windowId.trim()
    if (wanted === '') throw usage('Expected a window identifier after --window-id')
    if (!wanted.startsWith('0x')) return wanted
    const clients = await hyprctlJson<RawClient[]>(session, 'clients', [], { timeoutMs }) ?? []
    const client = clients.find(entry => entry.address.toLowerCase() === wanted.toLowerCase())
    if (client === undefined) {
      throw new HyprscopeError(ErrorCode.SCREENSHOT_FAILED, `No window has the address ${wanted}`, { address: wanted })
    }
    if (client.stableId === undefined || client.stableId === '') {
      throw new HyprscopeError(ErrorCode.SCREENSHOT_FAILED,
        'The compositor did not report a foreign-toplevel identifier for this window', {
          address: wanted,
          hint: 'This build may not implement ext-foreign-toplevel-list; capture a region instead',
        })
    }
    return client.stableId
  }
  const label = options.windowApp !== undefined ? 'application id' : 'title'
  const wanted = options.windowApp ?? options.windowTitle ?? ''
  if (wanted === '') throw usage('Expected a value for the window selector')
  const toplevels = await listToplevels(session, { timeoutMs })
  const matches = toplevels.filter(entry => options.windowApp !== undefined
    ? entry.appId === wanted
    : entry.title === wanted)
  if (matches.length === 0) {
    throw new HyprscopeError(ErrorCode.SCREENSHOT_FAILED, `No window has this ${label}`, {
      selector: wanted,
      available: toplevels.map(entry => options.windowApp !== undefined ? entry.appId : entry.title),
    })
  }
  if (matches.length > 1) {
    // Addresses, workspaces and the active workspace come from hyprctl; a
    // failure there must not hide the ambiguity, so both reads are best-effort.
    const [clients, activeWorkspace] = await Promise.all([
      hyprctlJson<RawClient[]>(session, 'clients', [], { timeoutMs }).catch(() => null),
      hyprctlJson<RawWorkspace>(session, 'activeworkspace', [], { timeoutMs }).catch(() => null),
    ])
    const activeWorkspaceId = typeof activeWorkspace?.id === 'number' ? activeWorkspace.id : null
    const candidates = windowCandidates(matches, clients ?? [], activeWorkspaceId)
    throw new HyprscopeError(ErrorCode.USAGE,
      `${matches.length} windows match this ${label}; use --window-id to pick one:\n`
        + renderWindowCandidates(candidates).join('\n'), {
        selector: wanted,
        candidates,
        hint: 'Pass --window-id with the window address shown above',
      })
  }
  return matches[0]!.identifier
}

/**
 * Report a failure and pick the exit code.
 * @param io Error target.
 * @param error Failure to report.
 * @param json Whether JSON was requested.
 * @returns Process exit code.
 */
function fail(io: Io, error: unknown, json: boolean): number {
  const failure = error instanceof HyprscopeError ? error
    : new HyprscopeError(ErrorCode.COMMAND_FAILED, error instanceof Error ? error.message : String(error))
  if (json) {
    io.stderr.write(`${JSON.stringify({ error: { code: failure.code, message: failure.message, details: failure.details } })}\n`)
  } else {
    io.stderr.write(`hyprscope: ${failure.code}: ${failure.message}\n`)
  }
  return failure.code === ErrorCode.USAGE ? 2 : 1
}

/**
 * List the ids of one capability level that the effective set does not grant.
 * @param level Level to select.
 * @param effective Capabilities the baseline grants.
 * @returns Ids in catalog order.
 */
function levelIds(level: CapabilityLevel, effective: ReadonlySet<CapabilityId>): string[] {
  return CAPABILITY_IDS.filter(id => capabilityLevel(id) === level && !effective.has(id))
}

/**
 * Read the accepted capability baseline for the doctor report.
 *
 * Doctor stays strictly read-only: this reads the file, never writes it, never
 * probes, and never throws. A malformed file is a fact to report; the reason it
 * is unusable appears in `warnings`.
 * @returns Baseline summary.
 */
async function baselineReport(resolved: ResolvedTarget): Promise<DoctorReport['baseline']> {
  const signature = resolved.baselineSignature
  const paths = baselinePaths(process.env, { signature })
  const empty = (): DoctorReport['baseline'] => ({
    present: false,
    state: null,
    path: paths.baselineFile,
    approvedAt: null,
    compositorVersion: null,
    target: resolved.target,
    staleness: null,
    degraded: levelIds('degraded', new Set<CapabilityId>()),
    missingRequired: levelIds('required', new Set<CapabilityId>()),
    warnings: [],
  })
  try {
    const result = await readBaseline(process.env, { signature })
    if (result.loaded === null) {
      const warnings = [...result.warnings]
      const reason = result.reason ?? 'no accepted baseline exists on this machine'
      // readBaseline reports the first parse warning as the reason; say it once.
      if (!warnings.includes(reason)) warnings.unshift(reason)
      return { ...empty(), path: result.path, warnings }
    }
    const effective = result.loaded.effective
    // The current hash is recomputed from the files, never copied from the
    // record: a record that disagrees with its configuration must read stale.
    const currentConfigHash = resolved.desktop === null || resolved.desktop.configDir === ''
      ? null
      : await hashDesktopConfig(resolved.desktop.configDir).catch(() => null)
    const observed = await measureEffective(resolved.session)
    const staleness = compareEffective(result.loaded.document.fingerprint, observed, {
      configHash: currentConfigHash,
      approvedAt: result.loaded.approvedAt,
    })
    return {
      present: true,
      state: result.loaded.state,
      path: result.path,
      approvedAt: result.loaded.approvedAt,
      compositorVersion: result.loaded.document.fingerprint.compositor.version,
      target: resolved.target,
      staleness: {
        verdict: staleness.verdict,
        reasons: staleness.reasons,
        measuredAt: staleness.measuredAt,
        differences: staleness.differences,
      },
      degraded: levelIds('degraded', effective),
      missingRequired: levelIds('required', effective),
      warnings: [...result.warnings],
    }
  } catch (error) {
    return {
      ...empty(),
      warnings: [`the baseline could not be read: ${error instanceof Error ? error.message : String(error)}`],
    }
  }
}

/**
 * Render the baseline line that closes the doctor report.
 * @param baseline Baseline summary.
 * @returns Human-readable lines.
 */
function renderBaselineSummary(baseline: DoctorReport['baseline']): string {
  const lines: string[] = []
  if (!baseline.present) {
    lines.push('baseline: none — control unavailable; run hyprscope control baseline --probe')
  } else {
    const approved = baseline.approvedAt === null ? 'not approved' : `approved ${baseline.approvedAt.slice(0, 10)}`
    const compositor = baseline.compositorVersion === null
      ? 'hyprland version unknown'
      : `hyprland ${baseline.compositorVersion}`
    lines.push(`baseline: ${baseline.state ?? 'incomplete'} · ${approved} · ${compositor} · ${baseline.path}`)
  }
  if (baseline.staleness !== null) {
    lines.push(`  staleness: ${baseline.staleness.verdict}`)
    for (const reason of baseline.staleness.reasons) lines.push(`    ${reason}`)
  }
  if (baseline.degraded.length > 0) lines.push(`  degraded: ${baseline.degraded.join(', ')}`)
  if (baseline.missingRequired.length > 0) {
    lines.push(`  missing required: ${baseline.missingRequired.join(', ')}`)
  }
  for (const warning of baseline.warnings) lines.push(`  warning: ${warning}`)
  return lines.join('\n')
}

/** One-line semantics of window capture; also reported in `limitations`. */
export const CAPTURE_WINDOW_SEMANTICS = 'window capture asks the compositor for the toplevel (ext-foreign-toplevel-list), so it also works for a mapped window on an inactive workspace or off-screen; it does not need the window to be visible, and the PNG carries the window size, not the output size'

/**
 * Find an executable by name on PATH or by absolute path.
 * @param name Binary name or path.
 * @param env Environment holding PATH.
 * @returns Absolute path when found, else null.
 */
function lookupExecutable(name: string, env: NodeJS.ProcessEnv): string | null {
  const candidate = (path: string): string | null => {
    try {
      if (!statSync(path).isFile()) return null
      accessSync(path, constants.X_OK)
      return path
    } catch {
      return null
    }
  }
  if (name.includes('/')) return candidate(name)
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (directory === '') continue
    const found = candidate(join(directory, name))
    if (found !== null) return found
  }
  return null
}

/**
 * Resolve the Quickshell binary the consent overlay starts.
 *
 * Doctor only looks it up: neither the overlay nor the binary is spawned, so the
 * report stays read-only.
 * @param env Environment to read (`HYPRSCOPE_QUICKSHELL` and `PATH`).
 * @returns Overlay runtime fact.
 */
export function resolveOverlayRuntime(env: NodeJS.ProcessEnv = process.env): DoctorReport['environment']['overlay'] {
  const override = env.HYPRSCOPE_QUICKSHELL
  const binary = override === undefined || override === '' ? 'quickshell' : override
  const source = override === undefined || override === '' ? 'default' : 'environment'
  const path = lookupExecutable(binary, env)
  if (path !== null) return { binary, path, available: true, source, hint: null }
  const fallback = lookupExecutable('qs', env)
  const hint = fallback === null
    ? 'install quickshell or point HYPRSCOPE_QUICKSHELL at the binary; observation still works, but consent cards cannot appear'
    : `quickshell is not on PATH; set HYPRSCOPE_QUICKSHELL=qs (found at ${fallback}) so the overlay finds it`
  return { binary, path: null, available: false, source, hint }
}

/**
 * Resolve the state directory shared by the baseline, lease and desktop records.
 * @param env Environment to read.
 * @returns Absolute `$XDG_STATE_HOME/hyprscope` path.
 */
export function stateDirectoryPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME || join(env.HOME ?? homedir(), '.local', 'state')
  return join(base, 'hyprscope')
}

/**
 * Check whether the state directory accepts a new file, without writing one.
 *
 * A missing directory is created on first use, so the nearest existing ancestor
 * is probed with `access(W_OK)`; nothing is created or deleted.
 * @param env Environment to read.
 * @returns State directory fact.
 */
export async function inspectStateDirectory(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DoctorReport['environment']['state']> {
  const path = stateDirectoryPath(env)
  const status = await stat(path).catch(() => null)
  if (status !== null && !status.isDirectory()) {
    return {
      path, exists: false, writable: false, probe: path,
      reason: 'the state path is occupied by a file, not a directory',
    }
  }
  if (status !== null) {
    try {
      await access(path, constants.W_OK)
      return { path, exists: true, writable: true, probe: path, reason: null }
    } catch (error) {
      return {
        path, exists: true, writable: false, probe: path,
        reason: `the state directory is not writable: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  let probe = dirname(path)
  while (true) {
    const ancestor = await stat(probe).catch(() => null)
    if (ancestor !== null) {
      if (!ancestor.isDirectory()) {
        return { path, exists: false, writable: false, probe, reason: `${probe} is not a directory` }
      }
      break
    }
    const parent = dirname(probe)
    if (parent === probe) {
      return {
        path, exists: false, writable: false, probe,
        reason: 'no existing parent directory is available for the state directory',
      }
    }
    probe = parent
  }
  try {
    await access(probe, constants.W_OK)
    return { path, exists: false, writable: true, probe, reason: null }
  } catch (error) {
    return {
      path, exists: false, writable: false, probe,
      reason: `the nearest existing ancestor ${probe} is not writable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * Limitations doctor prints; the `capture.window` line states when window capture works.
 * @returns Limitation lines.
 */
export function doctorLimitations(): string[] {
  return [
    'hyprscope is read-only: it never mutates the desktop. Mutation happens only through "hyprscope control" (lease + plan).',
    'Lock state is best-effort: only logind LockedHint is read, and a negative hint does not prove the session is unlocked.',
    'Every client of one compositor shares one wl_seat, so later input injection reaches the focused window of the user session.',
    `capture.window: ${CAPTURE_WINDOW_SEMANTICS}.`,
  ]
}

/**
 * Render the environment section doctor adds after the standard report.
 * @param environment Environment facts.
 * @returns Human-readable lines.
 */
export function renderEnvironmentSummary(environment: DoctorReport['environment']): string {
  const { overlay, state } = environment
  const overlayLine = overlay.available
    ? `${overlay.binary} at ${overlay.path} (${overlay.source})`
    : `${overlay.binary} not found on PATH (${overlay.source})`
  const writable = state.writable === null ? 'writability unknown' : state.writable ? 'writable' : 'not writable'
  const lines = [
    'environment',
    `  overlay runtime  ${overlayLine}`,
    `  state directory  ${state.path} (${state.exists ? 'exists' : 'missing'}, ${writable})`,
  ]
  if (overlay.hint !== null) lines.push(`  overlay hint     ${overlay.hint}`)
  if (state.reason !== null) lines.push(`  state hint       ${state.reason}`)
  return lines.join('\n')
}

/**
 * Probe the environment and report the observation surface.
 * @param session Discovered session.
 * @param options Parsed options.
 * @returns Doctor report.
 */
async function doctor(resolved: ResolvedTarget, options: CliOptions): Promise<DoctorReport> {
  const session = resolved.session
  const query = <T>(command: string) => hyprctlJson<T>(session, command, [], { timeoutMs: options.timeoutMs })
  const [version, status, clients, workspaces, monitors, layers, state, baseline] = await Promise.all([
    query<RawVersion>('version'), query<RawStatus>('status'), query<RawClient[]>('clients'),
    query<RawWorkspace[]>('workspaces'), query<RawMonitor[]>('monitors'), query<RawLayers>('layers'),
    inspectStateDirectory(process.env), baselineReport(resolved),
  ])
  let wayland: DoctorReport['capabilities']['wayland'] = null
  if (existsSync(probeBinaryPath())) {
    wayland = await probeWaylandGlobals(session, { timeoutMs: options.timeoutMs })
  }
  return {
    readOnly: true,
    observedAt: new Date().toISOString(),
    tool: { name: 'dsh-hyprscope', version: VERSION, stage: 2 },
    discovery: {
      runtimeDir: session.runtimeDir,
      instanceSignature: session.signature,
      pid: session.pid,
      instanceCount: session.instanceCount,
      discovery: session.source,
      waylandDisplay: session.waylandDisplay,
      waylandDisplaySource: session.waylandDisplaySource,
      inheritedEnvironment: session.inherited,
      candidates: listInstanceDirs(session.runtimeDir).map(instance => instance.signature),
    },
    compositor: {
      name: 'hyprland',
      version: version?.version ?? null,
      branch: version?.branch ?? null,
      commit: version?.commit ?? null,
      configProvider: status?.configProvider ?? null,
      backend: status?.backend ?? null,
    },
    inventory: {
      monitors: Array.isArray(monitors) ? monitors.length : 0,
      workspaces: Array.isArray(workspaces) ? workspaces.length : 0,
      clients: Array.isArray(clients) ? clients.length : 0,
      layers: normalizeLayers(layers).length,
    },
    target: { kind: resolved.target, signature: session.signature, managed: resolved.desktop !== null },
    capabilities: {
      observation: ['screenshot', 'events', 'clients', 'workspaces', 'monitors', 'layers', 'cursor', 'lockState'],
      action: [],
      wayland,
    },
    environment: {
      overlay: resolveOverlayRuntime(process.env),
      state,
      capture: { window: CAPTURE_WINDOW_SEMANTICS },
    },
    baseline,
    isolation: describeIsolation(),
    limitations: doctorLimitations(),
  }
}

/**
 * Stream events until the requested count, a match, or the deadline.
 * @param session Discovered session.
 * @param options Parsed options.
 * @param io Output target.
 * @returns Exit code.
 */
async function streamEvents(session: Session, options: CliOptions, io: Io): Promise<number> {
  const matcher = options.match === undefined ? null : new RegExp(options.match)
  const stream = new EventStream(session)
  const deadline = options.timeoutMs === undefined ? null : Date.now() + options.timeoutMs
  let printed = 0
  try {
    while (true) {
      const remaining = deadline === null ? undefined : deadline - Date.now()
      if (remaining !== undefined && remaining <= 0) {
        throw new HyprscopeError(ErrorCode.TIMEOUT, 'No matching event before the timeout', { timeoutMs: options.timeoutMs })
      }
      const event = await stream.next({ timeoutMs: remaining })
      if (event === null) return 0
      if (matcher !== null && !matcher.test(`${event.event}:${event.data}`)) continue
      io.stdout.write(options.json ? `${JSON.stringify(event)}\n` : `${event.event}  ${event.data}\n`)
      printed += 1
      if (options.once || (options.count !== undefined && printed >= options.count)) return 0
    }
  } catch (error) {
    if (error instanceof HyprscopeError && error.code === ErrorCode.TIMEOUT
      && !options.once && options.count === undefined) return 0
    throw error
  } finally {
    stream.close()
  }
}

/**
 * Run one command.
 * @param argv Arguments after the program name.
 * @param io Output targets.
 * @returns Process exit code.
 */
export async function main(
  argv: string[],
  io: Io = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    return fail(io, error, false)
  }
  const { options, command } = parsed
  if (options.version) {
    io.stdout.write(`hyprscope ${VERSION}\n`)
    return 0
  }
  if (options.help || command === undefined) {
    if (command === undefined && !options.help) {
      io.stderr.write(USAGE)
      return 2
    }
    io.stdout.write(USAGE)
    return 0
  }
  if (!(COMMANDS as readonly string[]).includes(command)) {
    const hint = CONTROL_COMMANDS.has(command)
      ? `Unknown command ${command}; control commands live under "hyprscope control ${command}"`
      : `Unknown command ${command}`
    return fail(io, usage(hint), options.json)
  }
  try {
    const resolved = await resolveTarget(parseDesktopTarget(options.desktop), {
      env: process.env, signature: options.signature, runtimeDir: options.runtimeDir,
    })
    const session = resolved.session
    const query = <T>(name: string) => hyprctlJson<T>(session, name, [], { timeoutMs: options.timeoutMs })
    switch (command) {
      case 'doctor': {
        const report = await doctor(resolved, options)
        print(io, report, options.json,
          value => `${format.renderDoctor(value)}\n\n${renderEnvironmentSummary(value.environment)}\n\n`
            + renderBaselineSummary(value.baseline))
        return 0
      }
      case 'state':
        print(io, await readState(session, options), options.json, format.renderState)
        return 0
      case 'active':
        print(io, await readActive(session, options), options.json, format.renderActive)
        return 0
      case 'clients':
        print(io, ((await query<RawClient[]>('clients')) ?? []).map(normalizeClient), options.json, format.renderClients)
        return 0
      case 'workspaces':
        print(io, ((await query<RawWorkspace[]>('workspaces')) ?? []).map(normalizeWorkspace), options.json,
          format.renderWorkspaces)
        return 0
      case 'monitors':
        print(io, ((await query<RawMonitor[]>('monitors')) ?? []).map(normalizeMonitor), options.json, format.renderMonitors)
        return 0
      case 'layers':
        print(io, normalizeLayers(await query<RawLayers>('layers')), options.json, format.renderLayers)
        return 0
      case 'cursor':
        print(io, await query<RawCursor>('cursorpos'), options.json, format.renderCursor)
        return 0
      case 'screenshot': {
        const lock = await readLockState()
        if (lock.locked === true && !options.allowLocked) {
          throw new HyprscopeError(ErrorCode.LOCKED, 'The session reports a lock; pass --allow-locked to capture anyway', { lock })
        }
        const selectors = [options.windowId, options.windowApp, options.windowTitle]
          .filter((value): value is string => value !== undefined)
        if (selectors.length > 1) throw usage('Choose one of --window-id, --window-app, or --window-title')
        if (selectors.length === 1 && (options.monitor !== undefined || options.region !== undefined)) {
          throw usage('A window capture cannot be combined with --monitor or --region')
        }
        // The destination is checked before any compositor work: an explicit
        // --output must point into an existing, writable directory, while the
        // default cache directory is created as before.
        const output = options.output ?? defaultCapturePath()
        await preflightCaptureOutput(output, { create: options.output === undefined })
        if (selectors.length === 1) {
          const identifier = await resolveWindowIdentifier(session, options)
          const result = await captureToplevel(session, {
            output,
            identifier,
            timeoutMs: options.timeoutMs ?? 10000,
          })
          print(io, result, options.json, format.renderScreenshot)
          return 0
        }
        const result = await capture(session, {
          output,
          monitor: options.monitor,
          region: options.region === undefined ? undefined : parseRegion(options.region),
          timeoutMs: options.timeoutMs ?? 10000,
        })
        print(io, result, options.json, format.renderScreenshot)
        return 0
      }
      case 'events':
        return await streamEvents(session, options, io)
      default:
        throw usage(`Unknown command ${command}`)
    }
  } catch (error) {
    return fail(io, error, options.json)
  }
}

export type { Client, DesktopState, LayerSurface, Monitor, Workspace }
