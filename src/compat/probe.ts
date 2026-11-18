/**
 * The capability probe: one installation-time measurement of this machine.
 *
 * The probe writes facts, never verdicts: every check records what was asked,
 * what came back, and whether it matched. It runs in two phases. The read-only
 * phase reads the compositor, the registry, the helpers, the event socket, and
 * the failsafe bind, and it captures a small region, without changing anything.
 *
 * The second phase is not a second injector. The probe builds a measure plan
 * (`probeplan.ts`) from the facts it already read, shows that plan on the lease
 * consent card, starts its own scratch client, and submits the plan to the
 * normal plan executor in measure mode. The executor is the only injector; the
 * probe only observes what the plan cannot assert itself (the injected key
 * reaching the scratch client, the window geometry after a move and a resize,
 * and the event-socket round trip) and turns all of it into capability evidence
 * (`derive.ts`).
 *
 * The probe is not gated by the baseline: it is what creates the baseline, and
 * the baseline can only narrow what the code declares. The consent card this
 * requests approves "letting the probe take the desktop briefly for
 * measurement", not the baseline itself; a human accepts that separately.
 */
import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants as fsConstants, existsSync, readFileSync } from 'node:fs'
import { access, appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { baselinePaths, computeState } from './baseline.ts'
import { CAPABILITY_IDS, CAPABILITY_SPECS, capabilityLevel } from './catalog.ts'
import { deriveMeasureEntries, KEY_F12_EVDEV, type MeasureObservations } from './derive.ts'
import { buildProbePlan, type ProbePlan, type ProbePlanInput } from './probeplan.ts'
import type {
  BaselineDocument, CapabilityCheck, CapabilityEntry, CapabilityId, CapabilityStatus, EvidenceLevel,
  Fingerprint, GlobalFingerprint, MonitorFingerprint,
} from './types.ts'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import { eventFields } from '../events.ts'
import { hyprctlJson } from '../hyprctl.ts'
import { defaultInjectorBinary, injectorArguments } from '../inject/injector.ts'
import { BIND_DESCRIPTION, DEFAULT_PANIC_KEY, hyprConfigDir, type BindRecord } from '../lease/bind.ts'
import { grantLease, releaseLease, requestLease } from '../lease/control.ts'
import { leasePaths } from '../lease/state.ts'
import { readLockState } from '../lock.ts'
import { tr, type RenderLanguage } from '../i18n.ts'
import { describePlanCard } from '../plan/card.ts'
import { executePlan, type MeasureStepFact } from '../plan/executor.ts'
import { assertPlanGrant, requirePlanGrant, type PlanGrant } from '../plan/leasegate.ts'
import { RunStore } from '../plan/runstore.ts'
import { EventTap, type TapEvent } from '../plan/tap.ts'
import { summarizePlan } from '../plan/validate.ts'
import { LiveWorld } from '../plan/world.ts'
import { capture } from '../screenshot.ts'
import { discoverSession } from '../session.ts'
import type { RawClient, RawCursor, RawMonitor, RawStatus, RawVersion, RawWorkspace, Session } from '../types.ts'
import { probeBinaryPath, probeWaylandGlobals } from '../wayland.ts'

const run = promisify(execFile)

/** Identifier of the fixed probe script the consent card approves. */
export const PROBE_SCRIPT = 'hyprscope-probe/2'

/** Reason shown on the lease card. */
const PROBE_REASON = { zh: '安装验收：能力探测', en: 'installation acceptance: capability probe' } as const

/** Longest the probe may hold control, in milliseconds. */
const PROBE_TTL_MS = 60_000

/** Time a measure plan may hold control beyond its own budget, in milliseconds. */
const PROBE_PLAN_TTL_MARGIN_MS = 10_000

/** Side of the single region capture, in layout pixels. */
const CAPTURE_SIZE = 64

/** Per-call limits for the helpers the probe runs. */
const HELPER_TIMEOUT_MS = 5_000
const HELPER_OUTPUT_CAP = 256 * 1024

/** App id and title the probe's own window sets; no other window is ever targeted. */
const SCRATCH_APP = 'hyprscope-scratch'
const SCRATCH_TITLE = 'hyprscope-scratch'

/** Waits around the scratch client's lifecycle, in milliseconds. */
const SCRATCH_READY_TIMEOUT_MS = 5_000
const SCRATCH_LOOKUP_TIMEOUT_MS = 5_000
const SCRATCH_CLOSE_TIMEOUT_MS = 3_000

/** Time the event socket gets to connect before the scratch client can open. */
const EVENT_CONNECT_MS = 150

/** Overall wall-clock budget of the measure phase. */
const TOTAL_MEASURE_BUDGET_MS = 45_000

/** Version of the tool that wrote the baseline. */
const TOOL_VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version

/** Options for {@link runProbe}. */
export interface ProbeOptions {
  /** Environment that owns the state directory and the helpers. */
  env?: NodeJS.ProcessEnv
  /** How long the lease card waits for the host. */
  consentMs?: number
  /** Requested control window; clamped to 60 s. */
  ttlMs?: number
  /** Measure without touching the desktop: no dispatch, injection, or scratch client. */
  readOnly?: boolean
  /** Injectable clock, for tests. */
  now?: () => Date
  /** Session to measure; defaults to discovery in `env`. */
  session?: Session
  /** Hash of the generated configuration, when the measured instance generated one. */
  configHash?: string | null
  /**
   * How the probe gets its lease. `programmatic` is only for a desktop whose own
   * consent already covers work inside it; the caller must have verified that.
   */
  consent?: 'card' | 'programmatic'
  /** Language of the consent card and the measurement plan's description; defaults to Chinese. */
  lang?: RenderLanguage
}

/** What one probe measured and where the raw evidence is. */
export interface ProbeOutcome {
  /** The verdict draft; `approval` is null until a human accepts it. */
  document: BaselineDocument
  probeId: string
  evidenceDir: string
  evidenceFile: string
  evidenceSha256: string
  /** Facts that explain capabilities left unknown or unsupported. */
  warnings: string[]
}

/** One parsed `wl-inject --probe` record. */
interface InjectProbe {
  seatCount: number
  seatName: number
  pointer: boolean
  keyboard: boolean
  globals: GlobalFingerprint[]
}

/** The rectangle spanned by every monitor, in layout coordinates. */
interface LayoutBox {
  x: number
  y: number
  width: number
  height: number
}

/** Shared inputs for one read-only measurement. */
interface ReadOnlyContext {
  session: Session
  env: NodeJS.ProcessEnv
  clock: () => Date
  log: (record: Record<string, unknown>) => Promise<void>
  evidenceDir: string
  warnings: string[]
  /** Whether the measure plan will run after this phase. */
  behavioral: boolean
}

/** What the read-only phase measured. */
interface ReadOnlyMeasurement {
  entries: Record<string, CapabilityEntry>
  fingerprint: Fingerprint
  /** Global layout extent, or null when no monitor was reported. */
  extent: { width: number; height: number } | null
  /** Monitor bounding box, or null when the layout is unusable. */
  layout: LayoutBox | null
}

/** One JSON line printed by the probe's scratch client. */
interface ScratchLine {
  at: number
  event: string
  code?: number
  state?: string
  width?: number
  height?: number
}

/** The probe's own Wayland window, its output lines, and its exit state. */
interface ScratchClient {
  child: ChildProcessByStdio<null, Readable, Readable>
  lines: ScratchLine[]
  stderr: string
  exited: boolean
}

/** Inputs for one measure-plan execution. */
interface MeasurePlanContext {
  session: Session
  env: NodeJS.ProcessEnv
  clock: () => Date
  log: (record: Record<string, unknown>) => Promise<void>
  grant: PlanGrant
  scratchPath: string
  plan: ProbePlan
  evidenceDir: string
  layout: LayoutBox | null
  warnings: string[]
}

/** What one measure-plan execution observed. */
interface MeasureRun {
  facts: MeasureStepFact[]
  observations: MeasureObservations
  runId: string
  status: string
  faultKind: string | null
}

/**
 * @param binds Binds reported by the compositor.
 * @returns Whether F12 is bound without modifiers.
 */
function plainF12Bound(binds: BindRecord[]): boolean {
  return binds.some(bind => (bind.modmask ?? 0) === 0 && (bind.key ?? '') === 'F12')
}

/**
 * @param error Unknown failure.
 * @returns One-line message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether a path exists and is executable.
 * @param path Candidate binary.
 * @returns Whether the process could be started.
 */
async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the scratch client.
 * @param env Environment that may override the binary.
 * @returns Absolute path under `bin/`.
 */
function scratchBinaryPath(env: NodeJS.ProcessEnv): string {
  return env.HYPRSCOPE_SCRATCH ?? fileURLToPath(new URL('../../bin/wl-scratch', import.meta.url))
}

/**
 * Parse the probe line printed by `wl-inject --probe`.
 * @param text Standard output of the helper.
 * @returns Seat facts and manager presence, or null when the output is unusable.
 */
function parseInjectProbe(text: string): InjectProbe | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  const managers = typeof record.managers === 'object' && record.managers !== null
    ? record.managers as Record<string, unknown>
    : {}
  const present = (name: string): boolean => {
    const value = managers[name]
    return typeof value === 'object' && value !== null && (value as Record<string, unknown>).present === true
  }
  const globals: GlobalFingerprint[] = Array.isArray(record.globals)
    ? (record.globals as unknown[]).flatMap(item => {
      if (typeof item !== 'object' || item === null) return []
      const entry = item as Record<string, unknown>
      return typeof entry.interface === 'string' && typeof entry.version === 'number'
        ? [{ interface: entry.interface, version: entry.version }]
        : []
    })
    : []
  return {
    seatCount: typeof record.seat_count === 'number' ? record.seat_count : 0,
    seatName: typeof record.seat_name === 'number' ? record.seat_name : 0,
    pointer: present('zwlr_virtual_pointer_manager_v1'),
    keyboard: present('zwp_virtual_keyboard_manager_v1'),
    globals,
  }
}

/**
 * Compute the rectangle spanned by every monitor.
 * @param monitors Raw `hyprctl -j monitors` records.
 * @returns Bounding box, or null when the layout is unusable.
 */
function layoutBox(monitors: RawMonitor[]): LayoutBox | null {
  if (monitors.length === 0) return null
  const xs = monitors.map(monitor => monitor.x)
  const ys = monitors.map(monitor => monitor.y)
  const right = monitors.map(monitor => monitor.x + monitor.width)
  const bottom = monitors.map(monitor => monitor.y + monitor.height)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const maxX = Math.max(...right)
  const maxY = Math.max(...bottom)
  if (![minX, minY, maxX, maxY].every(Number.isFinite) || maxX <= minX || maxY <= minY) return null
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/**
 * Take the registry global list, falling back to the helper's copy.
 * @param session Discovered session.
 * @param warnings Collector for a missing or failed probe binary.
 * @param fallback Globals reported by `wl-inject --probe`.
 * @returns Full registry list, unsorted.
 */
async function readRegistryGlobals(
  session: Session,
  warnings: string[],
  fallback: GlobalFingerprint[],
): Promise<GlobalFingerprint[]> {
  if (session.waylandDisplay === null) {
    warnings.push('no Wayland display was discovered, so the registry global list is empty')
    return fallback
  }
  if (!existsSync(probeBinaryPath())) {
    warnings.push('bin/wl-globals is not built (run pnpm run build:probe); the registry list falls back to wl-inject --probe')
    return fallback
  }
  try {
    const probe = await probeWaylandGlobals(session, { timeoutMs: HELPER_TIMEOUT_MS })
    return probe.globals
  } catch (error) {
    warnings.push(`bin/wl-globals failed: ${messageOf(error)}`)
    return fallback
  }
}

/**
 * Build one capability entry from the code catalog's level.
 * @param id Capability id.
 * @param status Verdict.
 * @param evidence Strength of the basis.
 * @param checks Recorded steps.
 * @param detail One sentence when unsupported or unknown.
 * @returns Entry ready for the baseline document.
 */
function makeEntry(
  id: CapabilityId,
  status: CapabilityStatus,
  evidence: EvidenceLevel,
  checks: CapabilityCheck[],
  detail: string | null = null,
): CapabilityEntry {
  return { level: capabilityLevel(id), status, evidence, checks, detail }
}

/**
 * Choose the entry with the stronger evidence; the measure plan wins a tie.
 * @param readOnly Entry from the read-only phase.
 * @param measured Entry derived from the measure plan.
 * @returns The entry that supports a claim with more evidence.
 */
function strongerEntry(readOnly: CapabilityEntry, measured: CapabilityEntry): CapabilityEntry {
  const rank: Record<EvidenceLevel, number> = { unknown: 0, advertised: 1, measured: 2 }
  return rank[measured.evidence] >= rank[readOnly.evidence] ? measured : readOnly
}

/** Details for capabilities no phase measured. */
const UNMEASURED_DETAILS: Partial<Record<CapabilityId, string>> = {
  'dispatch.window.move-to-workspace': 'no plan op uses this dispatcher, so the probe records it without sending a window to another workspace',
}

/**
 * Fill a capability the probe never measured.
 * @param id Capability id.
 * @param readOnly Whether the probe ran read-only.
 * @param scratch Whether a scratch client was available.
 * @returns Unknown entry with one sentence explaining why.
 */
function unmeasuredEntry(id: CapabilityId, readOnly: boolean, scratch: boolean): CapabilityEntry {
  const special = UNMEASURED_DETAILS[id]
  const detail = special ?? (readOnly
    ? `the probe ran read-only, so the round trip that measures this capability did not run (${CAPABILITY_SPECS[id].detection})`
    : !scratch
      ? 'bin/wl-scratch is not built, so the measurement round trip for this capability did not run'
      : `the measure plan did not measure this capability (${CAPABILITY_SPECS[id].detection})`)
  return makeEntry(id, 'unknown', 'unknown', [], detail)
}

/**
 * Keep only the entries whose evidence is an advertisement, for the derive step.
 * @param entries Read-only entries.
 * @returns Advertised seeds keyed by capability id.
 */
function advertisedEntries(entries: Record<string, CapabilityEntry>): Record<string, CapabilityEntry> {
  const advertised: Record<string, CapabilityEntry> = {}
  for (const [id, entry] of Object.entries(entries)) {
    if (entry.evidence === 'advertised' && entry.status !== 'unsupported') advertised[id] = entry
  }
  return advertised
}

/**
 * Read the facts the measure plan is built from, without changing anything.
 *
 * These reads happen before the consent card so the card can show the plan the
 * probe will actually submit; the read-only phase then re-reads the session for
 * the fingerprint and the observation checks after consent.
 * @param session Discovered session.
 * @returns Active workspace, layout origin, and active window the probe found.
 */
async function probePlanFacts(session: Session): Promise<ProbePlanInput> {
  const [activeWindow, activeWorkspace, monitors] = await Promise.all([
    hyprctlJson<RawClient>(session, 'activewindow', [], { timeoutMs: HELPER_TIMEOUT_MS }).catch(() => null),
    hyprctlJson<RawWorkspace>(session, 'activeworkspace', [], { timeoutMs: HELPER_TIMEOUT_MS }).catch(() => null),
    hyprctlJson<RawMonitor[]>(session, 'monitors', [], { timeoutMs: HELPER_TIMEOUT_MS }).catch(() => null),
  ])
  const box = layoutBox(Array.isArray(monitors) ? monitors : [])
  return {
    workspace: typeof activeWorkspace?.name === 'string' ? activeWorkspace.name : null,
    origin: box === null ? null : { x: box.x, y: box.y },
    restoreWindow: typeof activeWindow?.address === 'string' ? activeWindow.address : null,
  }
}

/**
 * Compare window addresses across Hyprland's two spellings.
 *
 * Event-socket payloads print the bare hexadecimal id ("560363f8f710");
 * client rows and dispatch requests carry the "0x" prefix.
 * @param value Address from either source.
 * @returns Lower-case id without the prefix, or null for an empty value.
 */
function normalizeAddress(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (trimmed === '') return null
  return trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed
}

/**
 * Identify the probe's scratch window from a client row.
 *
 * The scratch process id is deliberately not required: a probe run from inside
 * a pid namespace sees one pid locally while Hyprland reports the
 * compositor-side pid of the same client. The window class and title are the
 * identity the design names; the pid is only a tiebreaker.
 * @param row Raw client record.
 * @returns Whether the row carries the scratch class and title.
 */
function isScratchRow(row: RawClient): boolean {
  const app = row.class ?? row.initialClass
  return app === SCRATCH_APP && row.title === SCRATCH_TITLE
}

/**
 * Choose exactly one scratch row.
 * @param rows Current client rows.
 * @param expectedAddress Address the openwindow event named, when known.
 * @param pid Scratch process id, used only to break a tie.
 * @returns The selected row, or an ambiguity flag when more than one matches.
 */
function selectScratchRow(
  rows: RawClient[],
  expectedAddress: string | null,
  pid: number | null,
): { row: RawClient | null; ambiguous: boolean } {
  const candidates = rows.filter(isScratchRow)
  if (candidates.length === 0) return { row: null, ambiguous: false }
  if (candidates.length === 1) return { row: candidates[0] ?? null, ambiguous: false }
  // A stale scratch window from a crashed probe can share class and title with
  // the live one. The openwindow event names the window this run just opened.
  const wanted = normalizeAddress(expectedAddress)
  if (wanted !== null) {
    const byAddress = candidates.filter(row => normalizeAddress(row.address) === wanted)
    if (byAddress.length === 1) return { row: byAddress[0] ?? null, ambiguous: false }
  }
  if (pid !== null) {
    const byPid = candidates.filter(row => row.pid === pid)
    if (byPid.length === 1) return { row: byPid[0] ?? null, ambiguous: false }
  }
  return { row: null, ambiguous: true }
}

/**
 * @param row Raw client record.
 * @returns Integer geometry, or null when the row does not carry one.
 */
function rowGeometry(row: RawClient): { x: number; y: number; width: number; height: number } | null {
  const at = row.at
  const size = row.size
  if (!Array.isArray(at) || at.length !== 2 || !Array.isArray(size) || size.length !== 2) return null
  const [x, y] = at
  const [width, height] = size
  if (x === undefined || y === undefined || width === undefined || height === undefined) return null
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(width) || !Number.isInteger(height)) return null
  return { x, y, width, height }
}

/**
 * @param event Event-socket record.
 * @returns Whether it is the openwindow event for the probe's own window.
 */
function isScratchOpenEvent(event: TapEvent): boolean {
  if (event.event !== 'openwindow') return false
  const fields = eventFields(event.data)
  return fields[2] === SCRATCH_APP && fields[3] === SCRATCH_TITLE
}

/**
 * Read the current client rows.
 * @param session Discovered session.
 * @returns Client rows, empty when the read failed.
 */
async function readClients(session: Session): Promise<RawClient[]> {
  return (await hyprctlJson<RawClient[]>(session, 'clients', [], { timeoutMs: HELPER_TIMEOUT_MS })) ?? []
}

/**
 * Wait until exactly one scratch row exists.
 * @param session Discovered session.
 * @param expectedAddress Address the openwindow event named, when known.
 * @param pid Scratch process id, used only to break a tie.
 * @param timeoutMs Wait limit.
 * @returns Selection result; `row` is null on timeout.
 */
async function waitForScratchRow(
  session: Session,
  expectedAddress: string | null,
  pid: number | null,
  timeoutMs: number,
): Promise<{ row: RawClient | null; ambiguous: boolean }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const clients = await readClients(session).catch(() => [] as RawClient[])
    const selection = selectScratchRow(clients, expectedAddress, pid)
    if (selection.row !== null || selection.ambiguous) return selection
    if (Date.now() >= deadline) return selection
    await sleep(50)
  }
}

/**
 * Read the scratch window's geometry after the measure plan.
 * @param session Discovered session.
 * @param address Scratch window address, when known.
 * @param timeoutMs Wait limit.
 * @returns Integer geometry, or null when it could not be read.
 */
async function readScratchGeometry(
  session: Session,
  address: string | null,
  timeoutMs: number,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const clients = await readClients(session).catch(() => null)
    if (clients !== null) {
      const selection = selectScratchRow(clients, address, null)
      if (selection.row !== null) {
        const geometry = rowGeometry(selection.row)
        if (geometry !== null) return geometry
      }
    }
    if (Date.now() >= deadline) return null
    await sleep(50)
  }
}

/**
 * Wait until the closed scratch window is gone from the client list.
 * @param session Discovered session.
 * @param address Scratch window address.
 * @param timeoutMs Wait limit.
 * @returns Whether the window disappeared within the limit.
 */
async function waitForWindowGone(session: Session, address: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const wanted = normalizeAddress(address)
  for (;;) {
    const clients = await readClients(session).catch(() => null)
    if (clients !== null && !clients.some(row => normalizeAddress(row.address) === wanted)) return true
    if (Date.now() >= deadline) return false
    await sleep(50)
  }
}

/**
 * Environment for the probe's scratch client.
 * @param env Probe environment.
 * @param session Session the client must connect to.
 * @returns Child environment.
 */
function scratchEnvironment(env: NodeJS.ProcessEnv, session: Session): NodeJS.ProcessEnv {
  const display = session.waylandDisplay
    ?? (session.waylandSocket === null ? null : basename(session.waylandSocket))
  return {
    ...process.env,
    ...env,
    XDG_RUNTIME_DIR: session.runtimeDir,
    HYPRLAND_INSTANCE_SIGNATURE: session.signature,
    ...(display === null ? {} : { WAYLAND_DISPLAY: display }),
  }
}

/**
 * Start the probe's own Wayland client and collect its JSON lines.
 * @param binary Scratch client path.
 * @param env Child environment.
 * @param logPath File that receives the raw output.
 * @returns Handle used for waiting, signalling, and stopping.
 */
function startScratch(binary: string, env: NodeJS.ProcessEnv, logPath: string): ScratchClient {
  const child = spawn(binary, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const client: ScratchClient = { child, lines: [], stderr: '', exited: false }
  let buffered = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffered += chunk
    let index: number
    while ((index = buffered.indexOf('\n')) >= 0) {
      const raw = buffered.slice(0, index).replace(/\r$/, '').trim()
      buffered = buffered.slice(index + 1)
      if (raw === '') continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>
      } catch {
        continue
      }
      if (typeof parsed.event !== 'string') continue
      client.lines.push({
        at: Date.now(),
        event: parsed.event,
        ...(typeof parsed.code === 'number' ? { code: parsed.code } : {}),
        ...(typeof parsed.state === 'string' ? { state: parsed.state } : {}),
        ...(typeof parsed.width === 'number' ? { width: parsed.width } : {}),
        ...(typeof parsed.height === 'number' ? { height: parsed.height } : {}),
      })
      void appendFile(logPath, `${raw}\n`).catch(() => {})
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    client.stderr += chunk
    void appendFile(logPath, `[stderr] ${chunk}`).catch(() => {})
  })
  child.once('error', () => { client.exited = true })
  child.once('exit', () => { client.exited = true })
  return client
}

/**
 * Wait for one parsed scratch-client line.
 * @param client Scratch client handle.
 * @param match Predicate on the line.
 * @param timeoutMs Wait limit.
 * @returns The line, or null on timeout, exit, or missing output.
 */
async function waitForScratchLine(
  client: ScratchClient,
  match: (line: ScratchLine) => boolean,
  timeoutMs: number,
): Promise<ScratchLine | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = client.lines.find(match)
    if (found !== undefined) return found
    if (client.exited) return null
    if (Date.now() >= deadline) return null
    await sleep(20)
  }
}

/**
 * Stop the scratch client and let its output drain.
 * @param client Scratch client handle.
 * @param timeoutMs Time allowed between SIGTERM and SIGKILL.
 */
async function stopScratch(client: ScratchClient, timeoutMs: number): Promise<void> {
  if (!client.exited) {
    client.child.kill('SIGTERM')
    const deadline = Date.now() + Math.max(200, timeoutMs)
    while (!client.exited && Date.now() < deadline) await sleep(20)
    if (!client.exited) {
      client.child.kill('SIGKILL')
      const killDeadline = Date.now() + 500
      while (!client.exited && Date.now() < killDeadline) await sleep(20)
    }
  }
  // Let the stdout pipe deliver everything the process wrote before it exited.
  await sleep(20)
}

/**
 * Wait for one event-socket record after a mark.
 * @param tap Event tap the probe opened before the scratch client.
 * @param mark Position to search from.
 * @param match Predicate on the record.
 * @param timeoutMs Wait limit.
 * @returns The record, or null on timeout.
 */
async function waitForTapEvent(
  tap: EventTap,
  mark: number,
  match: (event: TapEvent) => boolean,
  timeoutMs: number,
): Promise<TapEvent | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = tap.since(mark).find(match)
    if (found !== undefined) return found
    if (Date.now() >= deadline) return null
    await sleep(15)
  }
}

/**
 * Run the measure plan and observe what only the probe can observe.
 *
 * The probe's only desktop-changing act is this call: the plan executor applies
 * every step under the lease the host approved, in measure mode. The probe
 * starts and stops its own scratch client around the run, lifts its fixed size
 * hints so the resize step is a real round trip, and reads back the effects the
 * plan cannot assert (the injected key and the final window geometry).
 * @param context Lease, plan, session, and evidence sinks.
 * @returns Step facts and observations for the capability derivation.
 */
async function runMeasurePlan(context: MeasurePlanContext): Promise<MeasureRun> {
  const { session, env, clock, log, grant, scratchPath, plan, evidenceDir, layout, warnings } = context
  const deadline = Date.now() + TOTAL_MEASURE_BUDGET_MS
  const remaining = (): number => Math.max(0, deadline - Date.now())
  const budget = (ms: number): number => Math.max(0, Math.min(ms, remaining()))
  const at = (): string => clock().toISOString()
  const store = new RunStore({ root: join(evidenceDir, 'runs') })
  const facts: MeasureStepFact[] = []
  const geometryChecks: CapabilityCheck[] = []
  const eventChecks: CapabilityCheck[] = []
  const observations: MeasureObservations = { keyPressed: false, geometry: null, geometryChecks, eventChecks }
  let scratch: ScratchClient | null = null
  let events: EventTap | null = null
  let world: LiveWorld | null = null
  let scratchAddress: string | null = null
  let openEvent: TapEvent | null = null
  let openOk = false
  let status = 'aborted'
  let faultKind: string | null = null
  try {
    // Subscribe before the client starts so the openwindow event cannot race.
    events = new EventTap(session)
    events.start()
    await sleep(EVENT_CONNECT_MS)
    scratch = startScratch(scratchPath, scratchEnvironment(env, session), join(evidenceDir, 'scratch.log'))
    await log({ source: 'measure', kind: 'scratch.start', pid: scratch.child.pid ?? null })
    const ready = await waitForScratchLine(scratch, line => line.event === 'ready', budget(SCRATCH_READY_TIMEOUT_MS))
    if (ready === null) await log({ source: 'measure', kind: 'scratch.ready.timeout', stderr: scratch.stderr.slice(-400) })
    openEvent = await waitForTapEvent(events, 0, isScratchOpenEvent, budget(SCRATCH_LOOKUP_TIMEOUT_MS))
    if (openEvent !== null) scratchAddress = normalizeAddress(eventFields(openEvent.data)[0] ?? null)
    const selection = await waitForScratchRow(session, scratchAddress, scratch.child.pid ?? null, budget(SCRATCH_LOOKUP_TIMEOUT_MS))
    if (selection.ambiguous) {
      throw new HyprscopeError(
        ErrorCode.FAULTED,
        'more than one window carries the scratch class and title, so the probe cannot tell its own window from a stale one',
      )
    }
    const row = selection.row
    if (row !== null) scratchAddress = row.address
    const geometry = row === null ? null : rowGeometry(row)
    const inside = geometry !== null && layout !== null
      && geometry.x >= layout.x && geometry.y >= layout.y
      && geometry.x + geometry.width <= layout.x + layout.width
      && geometry.y + geometry.height <= layout.y + layout.height
    geometryChecks.push({
      name: 'client-geometry',
      at: at(),
      expected: { integer: true, insideLayout: true },
      observed: {
        at: row?.at ?? null,
        size: row?.size ?? null,
        integer: geometry !== null,
        insideLayout: layout === null ? null : inside,
      },
      ok: geometry !== null && (layout === null || inside),
      ...(geometry === null ? { detail: 'the scratch window did not report an integer at/size pair' } : {}),
    })
    if (row === null) {
      // The window never mapped; submitting the plan would only collect
      // target.missing failures, so the capabilities stay unmeasured instead.
      const reason = 'the scratch window did not appear in hyprctl clients, so the measure plan was not executed'
      warnings.push(reason)
      await log({ source: 'measure', kind: 'scratch.missing', reason })
      return { facts, observations, runId: store.runId, status, faultKind }
    }
    // Lift the client's fixed 320x200 hints so the resize step is a real round
    // trip rather than an idempotent no-op against the size constraints.
    if (!scratch.child.kill('SIGUSR1')) {
      warnings.push('the scratch client did not accept SIGUSR1 before the measure plan, so the resize read-back may be constrained')
    }
    await sleep(120)
    world = new LiveWorld({
      session,
      assertGrant: () => assertPlanGrant(grant, env),
      lease: { id: grant.leaseId, statePath: leasePaths(env).stateFile },
    })
    const execution = await executePlan({
      plan: plan.plan,
      grant,
      world,
      store,
      checkLease: () => assertPlanGrant(grant, env),
      resumeAllowed: false,
      attempt: 0,
      maxResumes: 0,
      recoveryBudgetMs: plan.plan.budgetMs,
      measure: true,
      onMeasureStep: fact => {
        facts.push(fact)
        void log({
          source: 'measure', kind: 'step', step: fact.step, op: fact.op, stage: fact.stage,
          effect: fact.effect, violation: fact.violation, at: fact.at, durationMs: fact.durationMs,
        })
      },
    })
    if (execution.kind === 'done') {
      status = execution.result.status
      faultKind = execution.result.fault?.broken.kind ?? null
    } else {
      status = 'suspended'
      warnings.push('the measure plan suspended, which measurement mode never asks for')
    }
    await log({
      source: 'measure', kind: 'run', runId: store.runId, dir: store.dir, planId: plan.plan.id,
      status, fault: faultKind, facts: facts.length,
    })
    observations.geometry = await readScratchGeometry(session, scratchAddress, budget(1_000))
    observations.keyPressed = scratch.lines.some(line => line.event === 'key'
      && line.code === KEY_F12_EVDEV && line.state === 'pressed')
    await log({
      source: 'measure', kind: 'readback', geometry: observations.geometry,
      keyPressed: observations.keyPressed, scratchLines: scratch.lines.length,
    })
    openOk = openEvent !== null
      && (scratchAddress === null
        || normalizeAddress(eventFields(openEvent.data)[0] ?? null) === normalizeAddress(scratchAddress))
    return { facts, observations, runId: store.runId, status, faultKind }
  } finally {
    const closeMark = events === null ? 0 : events.mark()
    try {
      if (world !== null) await world.close()
    } catch (error) {
      void log({ source: 'measure', kind: 'world.close.error', detail: messageOf(error) })
    }
    try {
      if (scratch !== null) await stopScratch(scratch, budget(1_500))
    } catch (error) {
      void log({ source: 'measure', kind: 'scratch.stop.error', detail: messageOf(error) })
    }
    let closeOk = false
    let gone = false
    if (events !== null && scratchAddress !== null) {
      const address = scratchAddress
      const closed = await waitForTapEvent(
        events, closeMark,
        event => event.event === 'closewindow'
          && normalizeAddress(eventFields(event.data)[0] ?? null) === normalizeAddress(address),
        budget(SCRATCH_CLOSE_TIMEOUT_MS),
      )
      closeOk = closed !== null
      gone = await waitForWindowGone(session, address, budget(SCRATCH_CLOSE_TIMEOUT_MS))
    }
    try {
      events?.close()
    } catch (error) {
      void log({ source: 'measure', kind: 'events.close.error', detail: messageOf(error) })
    }
    // One check for the whole round trip: subscribing and then seeing the window
    // open and close is the only evidence that the event socket carries events.
    const detail = !openOk
      ? 'the openwindow event for the scratch window did not arrive'
      : !closeOk
        ? 'the closewindow event for the scratch window did not arrive'
        : !gone
          ? 'the closed scratch window stayed in hyprctl clients'
          : null
    eventChecks.push({
      name: 'event-round-trip',
      at: at(),
      expected: { app: SCRATCH_APP, title: SCRATCH_TITLE, window: scratchAddress },
      observed: { openwindow: openOk, closewindow: closeOk, windowGone: gone },
      ok: detail === null,
      ...(detail === null ? {} : { detail }),
    })
    void log({ source: 'measure', kind: 'events', openwindow: openOk, closewindow: closeOk, windowGone: gone })
  }
}

/**
 * Run one full probe: build the measure plan, ask for the lease, measure, write
 * evidence, release.
 *
 * The lease card and the baseline acceptance card are two separate consents:
 * this function only obtains the first, and the document it returns is a draft.
 * @param options Environment, consent bounds, and clock.
 * @returns The draft document plus where the evidence lives.
 * @throws HyprscopeError when the host does not allow the probe to measure.
 */
export async function runProbe(options: ProbeOptions = {}): Promise<ProbeOutcome> {
  const env = options.env ?? process.env
  const clock = options.now ?? ((): Date => new Date())
  const probeId = randomUUID()
  const evidenceDir = join(baselinePaths(env).evidenceRoot, probeId)
  const evidenceFile = join(evidenceDir, 'probe.jsonl')
  const warnings: string[] = []
  const scratchPath = scratchBinaryPath(env)
  const scratchReady = await isExecutable(scratchPath)
  const readOnlyPhase = options.readOnly === true
  const behavioral = !readOnlyPhase && scratchReady
  const mode: BaselineDocument['probe']['mode'] = readOnlyPhase || !scratchReady ? 'read-only' : 'full'
  const session = options.session ?? discoverSession({ env })
  // The measure plan is built before the card so the card shows exactly what the
  // probe will submit; the facts it needs are read-only.
  const lang: RenderLanguage = options.lang ?? 'zh'
  const plan = behavioral ? buildProbePlan({ ...(await probePlanFacts(session)), lang }) : null
  const ttlMs = plan === null
    ? Math.max(1_000, Math.min(options.ttlMs ?? PROBE_TTL_MS, PROBE_TTL_MS))
    : Math.max(1_000, Math.min(plan.plan.budgetMs + PROBE_PLAN_TTL_MARGIN_MS, PROBE_TTL_MS))
  const request = {
    reason: PROBE_REASON[lang],
    planBound: true,
    planSummary: plan === null
      ? { steps: 0, ops: [], workspace: null, summary: tr(lang, '能力探测', 'capability probe') }
      : summarizePlan(plan.plan),
    // The probe submits a plan, so it shows the same consent card as any plan.
    card: plan === null ? null : describePlanCard(plan.plan, { lang }),
    ttlMs,
  }
  const consent = options.consent === 'programmatic'
    ? await grantLease({ ...request, env, source: 'desktop' })
    : await requestLease({ ...request, consentMs: options.consentMs, maxResumes: 0, env, lang })
  if (!consent.allowed) {
    throw new HyprscopeError(ErrorCode.DENIED, `The host did not allow the probe to measure the desktop (${consent.reason})`, {
      leaseId: consent.leaseId, phase: consent.phase,
    })
  }
  let primary: unknown = null
  try {
    // Only create evidence once the host allowed the measurement; a denied card
    // leaves no empty directory behind.
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
    // The clock starts when control was granted: waiting for the card is the
    // host's time, not the probe's.
    const startedAt = clock()
    const grant = await requirePlanGrant(env)
    const log = async (record: Record<string, unknown>): Promise<void> => {
      await appendFile(evidenceFile, `${JSON.stringify({ at: clock().toISOString(), ...record })}\n`, { mode: 0o600 })
    }
    await log({
      source: 'probe', kind: 'start', script: PROBE_SCRIPT, mode, leaseId: grant.leaseId,
      readOnly: readOnlyPhase, scratch: scratchReady,
      plan: plan === null ? null : {
        id: plan.plan.id, steps: plan.plan.steps.length, checks: plan.checks.length,
        budgetMs: plan.plan.budgetMs, limitations: plan.limitations,
      },
    })
    if (readOnlyPhase) {
      warnings.push('the probe ran in read-only mode, so behavioral capabilities stay unknown')
    } else if (!scratchReady) {
      warnings.push('bin/wl-scratch is not built (run pnpm run build:scratch), so behavioral capabilities stay unknown')
    }
    const measurement = await measureReadOnly({
      session, env, clock, log, evidenceDir, warnings, behavioral,
    })
    const measuredEntries: Record<string, CapabilityEntry> = {}
    if (plan !== null) {
      try {
        const measured = await runMeasurePlan({
          session, env, clock, log, grant, scratchPath, plan,
          evidenceDir, layout: measurement.layout, warnings,
        })
        const derived = deriveMeasureEntries({
          measure: plan,
          facts: measured.facts,
          observations: measured.observations,
          advertised: advertisedEntries(measurement.entries),
        })
        Object.assign(measuredEntries, derived.entries)
        warnings.push(...derived.warnings)
        await log({
          source: 'measure', kind: 'finished', runId: measured.runId,
          status: measured.status, fault: measured.faultKind,
          capabilities: Object.keys(derived.entries).length,
        })
      } catch (error) {
        const detail = messageOf(error)
        warnings.push(`the measure plan stopped early: ${detail}`)
        await log({ source: 'measure', kind: 'aborted', detail })
      }
    }
    const entries: Record<string, CapabilityEntry> = {}
    for (const id of CAPABILITY_IDS) {
      const readOnlyEntry = measurement.entries[id]
      const measuredEntry = measuredEntries[id]
      const merged = readOnlyEntry === undefined
        ? measuredEntry
        : measuredEntry === undefined ? readOnlyEntry : strongerEntry(readOnlyEntry, measuredEntry)
      entries[id] = merged ?? unmeasuredEntry(id, readOnlyPhase, scratchReady)
    }
    const state = computeState(entries, warnings)
    const finishedAt = clock()
    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime())
    await log({ source: 'probe', kind: 'finished', state, durationMs, capabilities: CAPABILITY_IDS.length })
    const evidenceSha256 = createHash('sha256').update(await readFile(evidenceFile)).digest('hex')
    const document: BaselineDocument = {
      schema: 1,
      state,
      tool: { name: 'hyprscope', version: TOOL_VERSION },
      probe: {
        id: probeId,
        mode,
        script: PROBE_SCRIPT,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
      },
      fingerprint: { ...measurement.fingerprint, configHash: options.configHash ?? null },
      capabilities: entries,
      evidence: { file: evidenceFile, sha256: evidenceSha256 },
      approval: null,
      notes: [...warnings],
    }
    await writeFile(join(evidenceDir, 'summary.json'), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
    return { document, probeId, evidenceDir, evidenceFile, evidenceSha256, warnings }
  } catch (error) {
    primary = error
    throw error
  } finally {
    try {
      await releaseLease({ action: 'done', source: 'agent', env })
    } catch (error) {
      // Control must be given back; only report a release failure when the probe
      // itself succeeded, so it cannot hide the original error.
      if (primary === null) throw error
    }
  }
}

/**
 * Read everything the probe can learn without changing the desktop.
 * @param context Session, environment, sinks, and whether the plan will follow.
 * @returns Capability entries, the environment fingerprint, and the layout.
 */
async function measureReadOnly(context: ReadOnlyContext): Promise<ReadOnlyMeasurement> {
  const { session, env, clock, log, warnings } = context
  const at = (): string => clock().toISOString()
  const check = (name: string, ok: boolean, observed: unknown, extra: { expected?: unknown; detail?: string } = {}): CapabilityCheck => ({
    name,
    at: at(),
    ok,
    observed,
    ...(extra.expected === undefined ? {} : { expected: extra.expected }),
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
  })
  const reads = ['version', 'status', 'clients', 'monitors', 'workspaces', 'layers', 'activewindow',
    'activeworkspace', 'cursorpos', 'binds', 'configerrors'] as const
  const raw = new Map<string, unknown>()
  const failed = new Map<string, string>()
  for (const command of reads) {
    try {
      const value = await hyprctlJson<unknown>(session, command, [], { timeoutMs: HELPER_TIMEOUT_MS })
      if (value === null) {
        throw new HyprscopeError(ErrorCode.BAD_OUTPUT, `hyprctl ${command} printed nothing`, { command })
      }
      raw.set(command, value)
      await log({ source: 'read-only', kind: 'hyprctl', command, ok: true })
    } catch (error) {
      const detail = messageOf(error)
      failed.set(command, detail)
      await log({ source: 'read-only', kind: 'hyprctl', command, ok: false, detail })
    }
  }
  const read = (command: string): unknown => raw.get(command)
  const failure = (command: string): string | null => failed.get(command) ?? null
  const entries: Record<string, CapabilityEntry> = {}
  const version = failure('version') === null ? read('version') as RawVersion | null : null
  const status = failure('status') === null ? read('status') as RawStatus | null : null
  const monitors = Array.isArray(read('monitors')) ? read('monitors') as RawMonitor[] : []
  const clients = Array.isArray(read('clients')) ? read('clients') as RawClient[] : []
  const box = layoutBox(monitors)

  const requiredReads = ['version', 'status', 'clients', 'monitors', 'workspaces', 'layers', 'activewindow'] as const
  const observationChecks = requiredReads.map(command => check(
    `hyprctl ${command}`,
    failure(command) === null,
    failure(command) === null ? 'JSON parsed' : failure(command),
  ))
  const observationOk = observationChecks.every(entry => entry.ok)
  entries['observe.hyprctl'] = observationOk
    ? makeEntry('observe.hyprctl', 'supported', 'measured', observationChecks)
    : makeEntry('observe.hyprctl', 'unsupported', 'unknown', observationChecks,
      `hyprctl ${requiredReads.find(command => failure(command) !== null) ?? 'version'} did not return parseable JSON`)

  const cursor = failure('cursorpos') === null ? read('cursorpos') as RawCursor | null : null
  const cursorOk = typeof cursor?.x === 'number' && typeof cursor?.y === 'number'
  entries['observe.cursor'] = makeEntry('observe.cursor', cursorOk ? 'supported' : 'unsupported',
    cursorOk ? 'measured' : 'unknown',
    [check('cursorpos', cursorOk, cursor === null ? 'no cursor position' : { x: cursor.x, y: cursor.y })],
    cursorOk ? null : 'cursorpos did not return an integer pair')

  const geometryFields = clients.every(client => Array.isArray(client.at) && Array.isArray(client.size)
    && client.at.length === 2 && client.size.length === 2
    && client.at.every(Number.isInteger) && client.size.every(Number.isInteger))
  const insideLayout = box !== null && clients.every(client => intersects(client, box))
  const geometryChecks = [
    check('geometry-fields', geometryFields, { clients: clients.length }, {
      expected: 'every client carries integer at and size pairs',
    }),
    check('layout-space', box !== null && insideLayout, { layout: box, intersecting: insideLayout }, {
      expected: 'client rectangles intersect the monitor layout',
    }),
  ]
  if (!geometryFields) {
    entries['observe.geometry'] = makeEntry('observe.geometry', 'unsupported', 'unknown', geometryChecks,
      'a client is missing its integer at/size pair, so the coordinate system cannot be trusted')
  } else if (box === null) {
    entries['observe.geometry'] = makeEntry('observe.geometry', 'unsupported', 'unknown', geometryChecks,
      'no monitor layout was reported, so client geometry cannot be placed')
  } else if (!insideLayout) {
    entries['observe.geometry'] = makeEntry('observe.geometry', 'unknown', 'unknown', geometryChecks,
      'a client rectangle lies outside the monitor layout, so the coordinate system needs a round trip')
  } else {
    entries['observe.geometry'] = makeEntry('observe.geometry', 'supported', 'advertised', geometryChecks,
      'geometry fields are integral and inside the layout; the move round trip runs in the measure plan')
  }

  const modesOk = clients.length > 0 && clients.every(client => typeof client.fullscreen === 'number'
    && typeof client.fullscreenClient === 'number')
  entries['observe.window.modes'] = clients.length === 0
    ? makeEntry('observe.window.modes', 'unknown', 'unknown',
      [check('fullscreen-fields', false, 'no client window was open')],
      'no client window existed to expose the fullscreen mode fields')
    : makeEntry('observe.window.modes', modesOk ? 'supported' : 'unsupported', modesOk ? 'advertised' : 'unknown',
      [check('fullscreen-fields', modesOk, { clients: clients.length })],
      modesOk ? null : 'a client does not carry numeric fullscreen and fullscreenClient fields')

  const provider = status?.configProvider ?? null
  if (failure('status') !== null) {
    entries['dispatch.lua'] = makeEntry('dispatch.lua', 'unknown', 'unknown',
      [check('config-provider', false, failure('status'))],
      'hyprctl status failed, so the configuration provider could not be read')
  } else if (provider === 'lua') {
    entries['dispatch.lua'] = makeEntry('dispatch.lua', 'unknown', 'advertised',
      [check('config-provider', true, provider)],
      context.behavioral
        ? 'the configuration provider is lua; the workspace round trip runs in the measure plan'
        : 'the configuration provider is lua; no dispatch was sent because the probe ran read-only')
  } else {
    entries['dispatch.lua'] = makeEntry('dispatch.lua', 'unsupported', 'advertised',
      [check('config-provider', false, provider)],
      `the configuration provider is ${provider ?? 'unknown'}, not lua, so the dispatch subset does not apply`)
  }

  const lock = await readLockState()
  const lockOk = lock.source === 'loginctl' && lock.sessionId !== null
  await log({
    source: 'read-only', kind: 'lock', ok: lockOk, lockSource: lock.source, locked: lock.locked,
    detail: lock.reason ?? null,
  })
  entries['observe.lock'] = lockOk
    ? makeEntry('observe.lock', 'supported', 'advertised',
      [check('lock-field', true, { session: lock.sessionId, seat: lock.seat, locked: lock.locked })])
    : makeEntry('observe.lock', 'unknown', 'unknown',
      [check('lock-field', false, { source: lock.source, reason: lock.reason ?? null })],
      `the lock field is unavailable (${lock.reason ?? lock.source})`)

  const configDir = hyprConfigDir(env)
  const luaFile = join(configDir, 'hyprland.lua')
  let luaReadable = false
  try {
    await readFile(luaFile, 'utf8')
    luaReadable = true
  } catch {
    luaReadable = false
  }
  const binds = failure('binds') === null && Array.isArray(read('binds')) ? read('binds') as BindRecord[] : null
  const bound = binds !== null && binds.some(bind => (bind.description ?? '').includes('hyprscope failsafe'))
  const failsafeChecks = [
    check('lua-config', luaReadable, luaReadable ? luaFile : 'missing or unreadable', { expected: luaFile }),
    check('failsafe-bind', bound, binds === null ? 'hyprctl binds failed'
      : bound ? 'visible in hyprctl binds' : 'not found in hyprctl binds', { expected: BIND_DESCRIPTION }),
  ]
  if (binds === null) {
    entries['safety.failsafe-bind'] = makeEntry('safety.failsafe-bind', 'unknown', luaReadable ? 'advertised' : 'unknown',
      failsafeChecks, 'hyprctl binds failed, so the failsafe binding could not be observed')
  } else if (!luaReadable) {
    entries['safety.failsafe-bind'] = makeEntry('safety.failsafe-bind', 'unsupported', 'unknown', failsafeChecks,
      `no readable Hyprland Lua configuration at ${luaFile}`)
  } else if (!bound) {
    entries['safety.failsafe-bind'] = makeEntry('safety.failsafe-bind', 'unsupported', 'advertised', failsafeChecks,
      'the failsafe binding is not visible in hyprctl binds; run "hyprscope control install-bind"')
  } else {
    entries['safety.failsafe-bind'] = makeEntry('safety.failsafe-bind', 'supported', 'advertised', failsafeChecks)
  }

  const eventSocket = await socketState(session.eventSocket)
  entries['events.socket'] = eventSocket === 'socket'
    ? makeEntry('events.socket', 'unknown', 'advertised',
      [check('event-socket', true, session.eventSocket)],
      'the event socket exists; the round trip runs with the scratch client in the measure plan')
    : makeEntry('events.socket', 'unsupported', 'unknown',
      [check('event-socket', false, eventSocket)],
      eventSocket === 'missing' ? 'the compositor event socket does not exist'
        : 'the compositor event socket path exists but is not a socket')

  const injectPath = env.HYPRSCOPE_INJECT ?? defaultInjectorBinary()
  const injectReady = await isExecutable(injectPath)
  let inject: InjectProbe | null = null
  let injectError: string | null = null
  if (!injectReady) {
    injectError = 'bin/wl-inject is not built (run pnpm run build:inject)'
  } else {
    const childEnv: NodeJS.ProcessEnv = { ...env, XDG_RUNTIME_DIR: session.runtimeDir }
    if (session.waylandDisplay !== null) childEnv.WAYLAND_DISPLAY = session.waylandDisplay
    try {
      const { stdout } = await run(injectPath, ['--probe', ...injectorArguments({ session })], {
        env: childEnv, timeout: HELPER_TIMEOUT_MS, maxBuffer: HELPER_OUTPUT_CAP, encoding: 'utf8',
      })
      inject = parseInjectProbe(stdout)
      if (inject === null) injectError = 'wl-inject --probe did not print a usable JSON record'
    } catch (error) {
      injectError = `wl-inject --probe failed: ${messageOf(error)}`
    }
  }
  await log({
    source: 'read-only', kind: 'inject-probe', ok: inject !== null,
    seatCount: inject?.seatCount ?? null, pointer: inject?.pointer ?? null, keyboard: inject?.keyboard ?? null,
    detail: injectError,
  })
  const injectionEntry = (id: CapabilityId, present: boolean | null, protocol: string): CapabilityEntry => {
    if (present === null) {
      return makeEntry(id, 'unknown', 'unknown', [check('protocol-global', false, injectError ?? 'not measured')],
        injectError ?? 'the injection protocol could not be checked')
    }
    if (!present) {
      return makeEntry(id, 'unsupported', 'advertised',
        [check('protocol-global', false, `${protocol} is not advertised`)],
        `the compositor does not advertise ${protocol}`)
    }
    return makeEntry(id, 'unknown', 'advertised',
      [check('protocol-global', true, protocol)],
      context.behavioral
        ? `${protocol} is advertised; the round trip runs in the measure plan`
        : `${protocol} is advertised; no injection was attempted because the probe ran read-only`)
  }
  entries['inject.pointer'] = injectionEntry('inject.pointer', inject === null ? null : inject.pointer,
    'zwlr_virtual_pointer_manager_v1')
  entries['inject.keyboard'] = injectionEntry('inject.keyboard', inject === null ? null : inject.keyboard,
    'zwp_virtual_keyboard_manager_v1')

  entries['capture.grim'] = await measureCapture(context, session, monitors, lock.locked === true)

  const registry = await readRegistryGlobals(session, warnings, inject?.globals ?? [])
  const monitorsFingerprint: MonitorFingerprint[] = monitors.map(monitor => ({
    name: typeof monitor.name === 'string' ? monitor.name : 'unknown',
    x: monitor.x,
    y: monitor.y,
    width: monitor.width,
    height: monitor.height,
    scale: monitor.scale,
    refreshRate: monitor.refreshRate,
    transform: monitor.transform,
    dpmsStatus: monitor.dpmsStatus === true,
  })).sort((left, right) => left.name.localeCompare(right.name))
  // Effective values are recorded, not judged: the staleness check compares them
  // with the running instance, and a missing read stays null instead of failing
  // the capability probe.
  let followMouse: string | null = null
  try {
    const option = await hyprctlJson<{ int?: unknown; custom?: unknown; str?: unknown }>(
      session, 'getoption', ['input:follow_mouse'], { timeoutMs: HELPER_TIMEOUT_MS })
    if (typeof option?.int === 'number') followMouse = String(option.int)
    else if (typeof option?.custom === 'string') followMouse = option.custom
    else if (typeof option?.str === 'string') followMouse = option.str
  } catch {
    followMouse = null
  }
  const configErrors = failure('configerrors') !== null
    ? null
    : (Array.isArray(read('configerrors'))
      ? (read('configerrors') as unknown[]).map(String).filter(error => error.trim() !== '')
      : [])
  const effective: Fingerprint['effective'] = {
    configProvider: provider,
    followMouse,
    binds: binds === null ? null : { count: binds.length, plainF12: plainF12Bound(binds) },
    configErrors,
  }
  const fingerprint: Fingerprint = {
    compositor: {
      name: 'hyprland',
      version: version?.version ?? null,
      branch: version?.branch ?? null,
      commit: version?.commit ?? null,
      configProvider: provider,
      backend: status?.backend ?? null,
    },
    monitors: monitorsFingerprint,
    seats: inject === null ? { count: 0, name: 0 } : { count: inject.seatCount, name: inject.seatName },
    waylandGlobals: [...registry].sort((left, right) => left.interface.localeCompare(right.interface)),
    config: {
      dir: configDir,
      luaFile: luaReadable ? luaFile : null,
      failsafeKey: DEFAULT_PANIC_KEY,
      failsafeBound: luaReadable && bound,
    },
    helpers: { inject: injectReady, scratch: await isExecutable(scratchBinaryPath(env)) },
    effective,
    configHash: null,
  }
  return {
    entries,
    fingerprint,
    extent: box === null ? null : { width: box.width, height: box.height },
    layout: box,
  }
}

/**
 * Classify one path the compositor should be listening on.
 * @param path Socket path.
 * @returns `socket`, `missing`, or `other`.
 */
async function socketState(path: string): Promise<'socket' | 'missing' | 'other'> {
  try {
    const info = await stat(path)
    return info.isSocket() ? 'socket' : 'other'
  } catch {
    return 'missing'
  }
}

/**
 * Whether a client rectangle intersects the monitor layout.
 * @param client Raw client record.
 * @param box Layout bounding box.
 * @returns Whether the rectangles overlap.
 */
function intersects(client: RawClient, box: LayoutBox): boolean {
  if (!Array.isArray(client.at) || !Array.isArray(client.size)) return false
  const [x, y] = client.at
  const [width, height] = client.size
  return x < box.x + box.width && x + width > box.x && y < box.y + box.height && y + height > box.y
}

/**
 * Measure grim with one small region capture.
 *
 * A session that reports a lock is not captured, even when the caller asked for
 * a full probe: the screenshot path refuses locked sessions for the same reason.
 * @param context Read-only context.
 * @param session Discovered session.
 * @param monitors Raw monitor records.
 * @param locked Whether the session reports a lock.
 * @returns The capture capability entry.
 */
async function measureCapture(
  context: ReadOnlyContext,
  session: Session,
  monitors: RawMonitor[],
  locked: boolean,
): Promise<CapabilityEntry> {
  const at = (): string => context.clock().toISOString()
  if (locked) {
    return makeEntry('capture.grim', 'unknown', 'unknown', [],
      'the session reports a lock, so the probe did not capture the screen')
  }
  const monitor = monitors.find(candidate => candidate.focused === true)
    ?? [...monitors].sort((left, right) => String(left.name).localeCompare(String(right.name)))[0]
  if (monitor === undefined) {
    return makeEntry('capture.grim', 'unknown', 'unknown', [],
      'no monitor was reported, so there was no region to capture')
  }
  const width = Math.min(CAPTURE_SIZE, Math.floor(monitor.width))
  const height = Math.min(CAPTURE_SIZE, Math.floor(monitor.height))
  if (width <= 0 || height <= 0) {
    return makeEntry('capture.grim', 'unknown', 'unknown', [],
      'the reported monitor has no capturable area')
  }
  const region = { x: monitor.x, y: monitor.y, width, height }
  try {
    const result = await capture(session, {
      output: join(context.evidenceDir, 'capture.png'),
      region,
      timeoutMs: 8_000,
      env: context.env,
      now: context.clock(),
    })
    const ok = result.width === region.width && result.height === region.height
    await context.log({
      source: 'read-only', kind: 'capture', ok, file: result.path, width: result.width, height: result.height,
      bytes: result.bytes, sha256: result.sha256,
    })
    return makeEntry('capture.grim', ok ? 'supported' : 'unknown', ok ? 'measured' : 'unknown', [{
      name: 'region-capture',
      at: at(),
      expected: { width: region.width, height: region.height },
      observed: { width: result.width, height: result.height, bytes: result.bytes },
      ok,
    }], ok ? null : 'grim returned a PNG whose geometry does not match the requested region')
  } catch (error) {
    const detail = messageOf(error)
    await context.log({ source: 'read-only', kind: 'capture', ok: false, detail })
    return makeEntry('capture.grim', 'unsupported', 'unknown',
      [{ name: 'region-capture', at: at(), expected: region, observed: detail, ok: false, detail }],
      `grim could not capture a region: ${detail}`)
  }
}
