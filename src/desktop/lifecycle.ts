/**
 * Lifecycle of the agent-dedicated desktop: start, status, stop, and attach.
 *
 * `desktop.json` is a cache of what the tool started, never an authority: every
 * status read re-checks the pid and both sockets, and `stop` kills only a
 * desktop the tool started. The design contract is `docs/DESKTOP.md`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, statSync } from 'node:fs'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { baselinePaths, readBaseline } from '../compat/baseline.ts'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import { hyprctlJson } from '../hyprctl.ts'
import { quoteShell } from '../lease/bind.ts'
import { releaseLease } from '../lease/control.ts'
import { hyprscopeBin } from '../lease/overlay.ts'
import { processAlive } from '../process.ts'
import { discoverSession, listInstanceDirs, newestWaylandSocket, readLock, type InstanceLock } from '../session.ts'
import type { InstanceDirectory, Session } from '../types.ts'
import { validSize, writeDesktopConfig } from './config.ts'
import { hashDesktopConfig } from './hash.ts'
import {
  assertRuntimeRoot, clearDesktopRecord, desktopPaths, readDesktopRecord, writeDesktopRecord,
  type DesktopPaths,
} from './record.ts'
import type { DesktopConsent, DesktopRecord } from './types.ts'

/** One desktop's state, re-checked against the running system. */
export interface DesktopStatusReport {
  /** `absent` means no record exists; the other states describe a recorded desktop. */
  state: 'absent' | 'running' | 'closed' | 'stale'
  /** Which desktop the record describes; null when nothing is recorded. */
  target: 'agent' | 'external' | null
  record: DesktopRecord | null
  runtimeDir: string | null
  signature: string | null
  pid: number | null
  waylandDisplay: string | null
  configHash: string | null
  baseline: {
    /** Per-signature baseline path, or the machine-wide file when nothing is recorded. */
    file: string
    /** Whether an accepted baseline exists. */
    present: boolean
    state: 'usable' | 'degraded' | 'incomplete' | null
  }
  checks: {
    pid: boolean
    instance: boolean
    controlSocket: boolean
    waylandSocket: boolean
    configHash: boolean
  }
  /** Why the desktop is not running; null when it is. */
  detail: string | null
}

/** Options for {@link startDesktop}. */
export interface DesktopStartOptions {
  /** Requested output size, such as `1280x800`; null means the parent window size. */
  size?: string | null
  /** How the human consented; `chat` is the default. */
  consent?: 'chat' | 'card'
  /** One sentence the human was shown; a default is recorded when omitted. */
  consentNote?: string | null
  /** Environment that owns the state, runtime, and host session. */
  env?: NodeJS.ProcessEnv
  /** Readiness timeout in milliseconds; defaults to 20 seconds. */
  timeoutMs?: number
  /** Injected clock so tests can pin the consent timestamp. */
  now?: () => Date
}

/** Outcome of {@link stopDesktop}. */
export interface DesktopStopReport {
  /** `stopped` killed an agent desktop; `absent` had no record; `forgotten` only dropped an external record. */
  state: 'stopped' | 'absent' | 'forgotten'
  signature: string | null
  runtimeDir: string
  /** Whether the runtime root is gone; false when it was refused or could not be removed. */
  removed: boolean
  detail: string | null
}

/** Readiness facts gathered while waiting for a spawned compositor. */
interface ReadyDesktop {
  instance: InstanceDirectory
  waylandDisplay: string
}

/** Outcome of a runtime-root removal attempt. */
interface RuntimeRemoval {
  removed: boolean
  detail: string | null
}

const POLL_INTERVAL_MS = 100
const DEFAULT_START_TIMEOUT_MS = 20_000
const DEFAULT_STOP_TIMEOUT_MS = 5_000
const KILL_GRACE_MS = 2_000
const LOG_TAIL_CHARS = 2_000
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const WAYLAND_DISPLAY_PATTERN = /^wayland-[0-9]+$/
const DEFAULT_START_CONSENT_NOTE = 'Started an agent desktop (nested Hyprland) for this agent.'
const DEFAULT_ATTACH_CONSENT_NOTE = 'Attached to an external Hyprland instance for this agent.'

/** @returns The current time; the default clock for records. */
function defaultNow(): Date {
  return new Date()
}

/** @param milliseconds Delay in milliseconds. @returns Completion after the delay. */
function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolvePromise => { setTimeout(resolvePromise, milliseconds) })
}

/** @param path Candidate path. @returns Whether it is a unix socket. */
function isSocket(path: string): boolean {
  try { return statSync(path).isSocket() } catch { return false }
}

/** @param path Candidate path. @returns Whether it is a directory. */
function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

/** @param instanceDir Per-instance socket directory. @returns The lock pid, or null when unreadable. */
function lockPid(instanceDir: string): number | null {
  try { return readLock(instanceDir).pid } catch { return null }
}

/** @param instanceDir Per-instance socket directory. @returns The parsed lock, or null when unreadable. */
function lockOf(instanceDir: string): InstanceLock | null {
  try { return readLock(instanceDir) } catch { return null }
}

/**
 * Read the tail of the desktop log for failure details.
 * @param logFile Log file path.
 * @param maxChars Maximum number of trailing characters.
 * @returns The tail, or an empty string when the log cannot be read.
 */
function logTail(logFile: string, maxChars = LOG_TAIL_CHARS): string {
  try {
    const text = readFileSync(logFile, 'utf8')
    return (text.length <= maxChars ? text : text.slice(-maxChars)).trim()
  } catch {
    return ''
  }
}

/**
 * Compute the host Wayland socket the nested compositor connects to.
 * @param session Discovered host session.
 * @returns Absolute socket path, or null when the host has none.
 */
function hostWaylandSocket(session: Session): string | null {
  const display = session.waylandDisplay
  if (display !== null && isAbsolute(display)) return display
  return session.waylandSocket
}

/**
 * Build the environment for the nested compositor.
 *
 * The signature is dropped so the child cannot attach to the user's instance,
 * and `XDG_RUNTIME_DIR` points at the disposable runtime root.
 * @param env Caller environment.
 * @param runtimeRoot Runtime root the child must use.
 * @param waylandSocket Absolute host Wayland socket.
 * @returns Child environment.
 */
function childEnvironment(env: NodeJS.ProcessEnv, runtimeRoot: string, waylandSocket: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env }
  delete child.HYPRLAND_INSTANCE_SIGNATURE
  return {
    ...child,
    XDG_RUNTIME_DIR: runtimeRoot,
    WAYLAND_DISPLAY: waylandSocket,
    HYPRLAND_NO_SD_NOTIFY: '1',
    HYPRSCOPE_DESKTOP: 'agent',
  }
}

/**
 * Build the panic command for this desktop's own lease.
 *
 * The nested compositor must release its own lease, not the user's, so the
 * shortcut is built here instead of reusing the host bind's command.
 * @param env Environment that selects the Node binary and entry point.
 * @returns Shell command string for `hl.dsp.exec_cmd`.
 */
function desktopPanicCommand(env: NodeJS.ProcessEnv): string {
  return [env.HYPRSCOPE_NODE ?? process.execPath, hyprscopeBin(), 'control', 'panic', '--desktop', 'agent', '--source', 'shortcut']
    .map(quoteShell).join(' ')
}

/**
 * Refuse to start when the host's configuration provider cannot read Lua.
 *
 * The generated configuration is Lua because the test machine and the design
 * target use the Lua provider; handing it to a hyprlang compositor would only
 * produce a half-configured desktop. An unreadable provider is not fatal here:
 * the spawn failure carries the log tail that explains what happened.
 * @param session Host session.
 * @param env Environment that may select a stand-in compositor.
 * @throws HyprscopeError when the provider is known and is not `lua`.
 */
async function assertLuaHost(session: Session, env: NodeJS.ProcessEnv): Promise<void> {
  // Tests and developers may point the lifecycle at a stand-in compositor; that
  // stand-in has no hyprctl to answer, so the provider is decided by the spawn.
  if (env.HYPRSCOPE_HYPRLAND !== undefined) return
  try {
    const status = await hyprctlJson<{ configProvider?: string }>(session, 'status')
    const provider = status?.configProvider
    if (typeof provider === 'string' && provider !== 'lua') {
      throw new HyprscopeError(ErrorCode.DESKTOP_FAILED,
        `The host uses the ${provider} configuration provider; the agent desktop is generated as Lua and cannot start here`,
        { provider, host: session.signature })
    }
  } catch (error) {
    if (error instanceof HyprscopeError && error.code === ErrorCode.DESKTOP_FAILED) throw error
  }
}

/**
 * Wait until the nested compositor exposes its instance and Wayland sockets.
 *
 * The instance is matched by the pid in `hyprland.lock`; the only instance is
 * accepted as a fallback so a lock file that appears late cannot hide a
 * compositor that is otherwise ready.
 * @param runtimeRoot Runtime root the child uses.
 * @param pid Child process id.
 * @param timeoutMs Readiness timeout.
 * @returns The matched instance and the Wayland display basename.
 */
async function waitForReady(runtimeRoot: string, pid: number, timeoutMs: number): Promise<ReadyDesktop> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const instances = listInstanceDirs(runtimeRoot)
    const matched = instances.find(instance => lockPid(instance.dir) === pid)
    const only = instances.length === 1 ? instances[0] : undefined
    const instance = matched ?? only
    const waylandDisplay = newestWaylandSocket(runtimeRoot)
    if (instance !== undefined && instance.hasControl && waylandDisplay !== null) {
      return { instance, waylandDisplay }
    }
    if (Date.now() >= deadline) {
      throw new HyprscopeError(ErrorCode.DESKTOP_FAILED,
        `The nested compositor did not become ready within ${timeoutMs}ms`,
        {
          runtimeRoot, pid, timeoutMs,
          instances: instances.map(candidate => candidate.signature),
          waylandDisplay,
        })
    }
    await sleep(POLL_INTERVAL_MS)
  }
}

/**
 * Reject a runtime root that must never be removed recursively.
 * @param target Resolved runtime root.
 * @param env Environment that supplies the home directory.
 * @returns A refusal sentence, or null when removal is allowed.
 */
function unsafeRuntimeRootReason(target: string, env: NodeJS.ProcessEnv): string | null {
  if (target === '' || target === '/') return `refusing to remove ${JSON.stringify(target)}`
  const homes = new Set<string>()
  if (env.HOME !== undefined && env.HOME !== '') homes.add(resolve(env.HOME))
  homes.add(resolve(homedir()))
  if (homes.has(target)) return `refusing to remove the home directory ${target}`
  return null
}

/**
 * Remove the managed runtime root, refusing anything that is not it.
 * @param runtimeRoot Runtime root to remove.
 * @param env Environment that owns the desktop paths.
 * @returns Whether the root is gone, with the reason when it is not.
 */
async function removeRuntimeRoot(runtimeRoot: string, env: NodeJS.ProcessEnv): Promise<RuntimeRemoval> {
  if (runtimeRoot === '') return { removed: false, detail: 'refusing to remove an empty runtime root' }
  const target = resolve(runtimeRoot)
  const unsafe = unsafeRuntimeRootReason(target, env)
  if (unsafe !== null) return { removed: false, detail: unsafe }
  const expected = resolve(desktopPaths(env).runtimeRoot)
  if (target !== expected) {
    return { removed: false, detail: `refusing to remove ${target}: the desktop runtime root is ${expected}` }
  }
  try {
    await rm(target, { recursive: true, force: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error'
    return { removed: false, detail: `removing ${target} failed (${code})` }
  }
  if (existsSync(target)) return { removed: false, detail: `${target} still exists after removal` }
  return { removed: true, detail: null }
}

/**
 * Signal a process group, falling back to the process itself.
 * @param pid Process id that is normally the group leader.
 * @param signal Signal to send.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
    return
  } catch {
    // A pid that is not a group leader still has to be stopped.
  }
  try { process.kill(pid, signal) } catch {
    // The process is already gone.
  }
}

/**
 * Terminate a process group politely, then forcefully.
 * @param pid Recorded process id, or null.
 * @param graceMs How long to wait after SIGTERM before SIGKILL.
 */
async function terminate(pid: number | null, graceMs: number): Promise<void> {
  if (pid === null || pid <= 0) return
  if (processAlive(pid)) {
    signalGroup(pid, 'SIGTERM')
    const deadline = Date.now() + graceMs
    while (Date.now() < deadline && processAlive(pid)) await sleep(POLL_INTERVAL_MS)
  }
  if (processAlive(pid)) signalGroup(pid, 'SIGKILL')
}

/**
 * Wrap a failure in the desktop's coded error.
 * @param error Original failure.
 * @param code Error code to report.
 * @param prefix Sentence added when the failure was not already coded.
 * @returns A {@link HyprscopeError}.
 */
function asDesktopError(error: unknown, code: (typeof ErrorCode)[keyof typeof ErrorCode], prefix: string): HyprscopeError {
  if (error instanceof HyprscopeError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new HyprscopeError(code, `${prefix}: ${message}`, { cause: message })
}

/**
 * Build the failure for a start that already spawned the compositor.
 * @param error Original failure.
 * @param paths Desktop paths that hold the log.
 * @param removal Result of removing the runtime root.
 * @returns A coded failure carrying the log tail.
 */
function startFailure(error: unknown, paths: DesktopPaths, removal: RuntimeRemoval): HyprscopeError {
  const base = error instanceof HyprscopeError ? error : null
  const message = base?.message ?? (error instanceof Error ? error.message : String(error))
  return new HyprscopeError(ErrorCode.DESKTOP_FAILED, message, {
    ...(base?.details ?? {}),
    logTail: logTail(paths.logFile),
    runtimeRoot: paths.runtimeRoot,
    runtimeRootRemoved: removal.removed,
    ...(removal.detail === null ? {} : { removalDetail: removal.detail }),
  })
}

/**
 * Build the consent record.
 * @param source Caller-provided source.
 * @param note Caller-provided note.
 * @param fallback Default note.
 * @param at ISO timestamp.
 * @returns Consent record.
 */
function consentRecord(
  source: 'chat' | 'card' | undefined,
  note: string | null | undefined,
  fallback: string,
  at: string,
): DesktopConsent {
  return { source: source ?? 'chat', at, note: note ?? fallback }
}

/**
 * Compare the generated configuration with the recorded hash.
 * @param record Record whose config should be checked.
 * @returns Whether the hash still matches, or no hash was recorded.
 */
async function configHashMatches(record: DesktopRecord): Promise<boolean> {
  if (record.configHash === null) return true
  try {
    return (await hashDesktopConfig(record.configDir)) === record.configHash
  } catch {
    return false
  }
}

/**
 * Read a per-signature baseline without ever failing the status report.
 * @param env Environment that owns the state directory.
 * @param signature Recorded instance signature.
 * @returns Baseline presence and state.
 */
async function baselineFacts(
  env: NodeJS.ProcessEnv,
  signature: string,
): Promise<DesktopStatusReport['baseline']> {
  let file = ''
  try {
    file = baselinePaths(env, { signature }).baselineFile
  } catch {
    file = ''
  }
  try {
    const result = await readBaseline(env, { signature })
    return { file: result.path, present: result.loaded !== null, state: result.loaded?.state ?? null }
  } catch {
    return { file, present: false, state: null }
  }
}

/**
 * Build a status report for an existing record.
 * @param record Recorded desktop.
 * @param env Environment that owns the state directory.
 * @returns Report with every check evaluated.
 */
async function inspectRecord(record: DesktopRecord, env: NodeJS.ProcessEnv): Promise<DesktopStatusReport> {
  const runtimeDir = record.runtimeDir
  const instanceDir = join(runtimeDir, 'hypr', record.signature)
  const controlSocket = join(instanceDir, '.socket.sock')
  const waylandSocket = join(runtimeDir, record.waylandDisplay)
  const pidAlive = record.pid === null ? true : processAlive(record.pid)
  const instance = isDirectory(instanceDir)
  const control = isSocket(controlSocket)
  const wayland = isSocket(waylandSocket)
  const configMatches = await configHashMatches(record)
  const checks = {
    pid: pidAlive,
    instance,
    controlSocket: control,
    waylandSocket: wayland,
    configHash: configMatches,
  }
  const running = record.state === 'running' && pidAlive && instance && control && wayland && configMatches
  const closed = !instance && !control && !wayland && (record.pid === null || !pidAlive)
  const state: DesktopStatusReport['state'] = running ? 'running' : closed ? 'closed' : 'stale'
  let detail: string | null = null
  if (state === 'closed') {
    detail = record.detail ?? 'the desktop instance is gone'
  } else if (state === 'stale') {
    if (!instance) detail = `the instance directory ${instanceDir} is gone`
    else if (!control) detail = `the control socket ${controlSocket} is gone`
    else if (!wayland) detail = `the Wayland socket ${waylandSocket} is gone`
    else if (!pidAlive) detail = `the desktop process ${record.pid} is gone`
    else if (!configMatches) detail = `the generated configuration under ${record.configDir} changed since the desktop started`
    else detail = `the record says the desktop is ${record.state}`
  }
  return {
    state,
    target: record.target,
    record,
    runtimeDir,
    signature: record.signature,
    pid: record.pid,
    waylandDisplay: record.waylandDisplay,
    configHash: record.configHash,
    baseline: await baselineFacts(env, record.signature),
    checks,
    detail,
  }
}

/**
 * Report what the recorded desktop looks like right now.
 *
 * Strictly read-only: it reads the record, stats the sockets, probes the pid,
 * hashes the generated configuration, and reads the baseline. It never writes.
 * @param env Environment that owns the state and runtime directories.
 * @returns Status report; `absent` when no desktop is recorded.
 */
export async function statusDesktop(env: NodeJS.ProcessEnv = process.env): Promise<DesktopStatusReport> {
  const read = await readDesktopRecord(env)
  if (read.record === null) {
    return {
      state: 'absent',
      target: null,
      record: null,
      runtimeDir: null,
      signature: null,
      pid: null,
      waylandDisplay: null,
      configHash: null,
      baseline: { file: baselinePaths(env).baselineFile, present: false, state: null },
      checks: { pid: false, instance: false, controlSocket: false, waylandSocket: false, configHash: false },
      detail: read.warnings[0] ?? null,
    }
  }
  return inspectRecord(read.record, env)
}
/**
 * Start a nested Hyprland dedicated to this agent.
 *
 * A stale record is cleaned first; a running one is refused. The compositor is
 * spawned detached under the desktop runtime root, its readiness is verified
 * against its lock file and both sockets, and the record is written only then.
 * @param options Size, consent, environment, timeout, and clock.
 * @returns Status of the desktop as it was just recorded.
 * @throws HyprscopeError `NO_SESSION` without a host display, `USAGE` for an
 *   invalid size, and `DESKTOP_FAILED` when the desktop is already running or
 *   does not become ready.
 */
export async function startDesktop(options: DesktopStartOptions = {}): Promise<DesktopStatusReport> {
  const env = options.env ?? process.env
  const paths = desktopPaths(env)
  assertRuntimeRoot(paths.runtimeRoot)

  const existing = (await readDesktopRecord(env)).record
  if (existing !== null) {
    const current = await statusDesktop(env)
    // A hash mismatch makes the record stale, but if its process and instance
    // are still there the compositor is alive: starting over would orphan it.
    if (current.state === 'running' || (current.checks.pid && current.checks.instance)) {
      throw new HyprscopeError(ErrorCode.DESKTOP_FAILED,
        `The desktop ${existing.signature} is already running; stop the current desktop first`,
        { signature: existing.signature, target: existing.target, runtimeDir: existing.runtimeDir, pid: existing.pid })
    }
    const cleanup = await removeRuntimeRoot(paths.runtimeRoot, env)
    if (!cleanup.removed) {
      throw new HyprscopeError(ErrorCode.DESKTOP_FAILED,
        `The stale desktop runtime root could not be cleaned: ${cleanup.detail ?? 'unknown error'}`,
        { runtimeRoot: paths.runtimeRoot, detail: cleanup.detail })
    }
    await clearDesktopRecord(env)
  } else {
    // No record but live sockets under our runtime root: another desktop is
    // still running. Removing the root would orphan it, so refuse instead.
    const orphans = listInstanceDirs(paths.runtimeRoot)
      .filter(instance => {
        const pid = lockPid(instance.dir)
        return pid !== null && processAlive(pid)
      })
    if (orphans.length > 0) {
      throw new HyprscopeError(ErrorCode.DESKTOP_FAILED,
        `A compositor is still running under ${paths.runtimeRoot} (${orphans.map(item => item.signature).join(', ')}); stop it first`,
        { runtimeRoot: paths.runtimeRoot, signatures: orphans.map(item => item.signature) })
    }
  }

  const host = discoverSession({ env, excludeSignature: existing?.signature })
  const hostSocket = hostWaylandSocket(host)
  if (hostSocket === null || !isSocket(hostSocket)) {
    throw new HyprscopeError(ErrorCode.NO_SESSION,
      `The host session ${host.signature} has no Wayland socket to nest inside`,
      { signature: host.signature, runtimeDir: host.runtimeDir, waylandDisplay: host.waylandDisplay })
  }

  await assertLuaHost(host, env)

  const size = options.size ?? null
  if (size !== null && !validSize(size)) {
    throw new HyprscopeError(ErrorCode.USAGE,
      `Desktop size ${size} is not valid; expected WIDTHxHEIGHT such as 1280x800`,
      { size })
  }

  let generated: Awaited<ReturnType<typeof writeDesktopConfig>>
  try {
    generated = await writeDesktopConfig({
      configDir: paths.configDir,
      size,
      panicCommand: desktopPanicCommand(env),
      env,
    })
  } catch (error) {
    throw asDesktopError(error, ErrorCode.DESKTOP_FAILED, 'The desktop configuration could not be generated')
  }

  const createdAt = (options.now ?? defaultNow)().toISOString()
  const timeoutMs = options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS
  let child: ChildProcess | null = null
  try {
    await mkdir(paths.runtimeRoot, { recursive: true, mode: 0o700 })
    await chmod(paths.runtimeRoot, 0o700)
    await mkdir(paths.logsDir, { recursive: true, mode: 0o700 })
    const logFd = openSync(paths.logFile, 'a', 0o600)
    let spawned: ChildProcess
    try {
      spawned = spawn(env.HYPRSCOPE_HYPRLAND ?? 'Hyprland', ['-c', generated.file], {
        env: childEnvironment(env, paths.runtimeRoot, hostSocket),
        stdio: ['ignore', logFd, logFd],
        detached: true,
      })
    } finally {
      closeSync(logFd)
    }
    child = spawned
    spawned.unref()
    const exited = new Promise<never>((_resolve, reject) => {
      spawned.once('error', error => { reject(error) })
      spawned.once('exit', (code, signal) => {
        const how = signal ?? 'code ' + String(code)
        reject(new HyprscopeError(ErrorCode.DESKTOP_FAILED,
          'The nested compositor exited before it was ready (' + how + ')',
          { code, signal }))
      })
    })
    // A rejection arriving after readiness is not a start failure any more.
    void exited.catch(() => {})
    const childPid = spawned.pid ?? null
    if (childPid === null) {
      throw new HyprscopeError(ErrorCode.DESKTOP_FAILED,
        `The nested compositor ${env.HYPRSCOPE_HYPRLAND ?? 'Hyprland'} produced no process id`,
        { binary: env.HYPRSCOPE_HYPRLAND ?? 'Hyprland' })
    }
    const ready = await Promise.race([waitForReady(paths.runtimeRoot, childPid, timeoutMs), exited])

    const record: DesktopRecord = {
      schema: 1,
      target: 'agent',
      state: 'running',
      runtimeDir: paths.runtimeRoot,
      signature: ready.instance.signature,
      waylandDisplay: ready.waylandDisplay,
      pid: childPid,
      configDir: paths.configDir,
      configHash: generated.hash,
      size,
      consent: consentRecord(options.consent, options.consentNote, DEFAULT_START_CONSENT_NOTE, createdAt),
      createdAt,
      updatedAt: createdAt,
      detail: null,
    }
    await writeFile(paths.pidFile, String(childPid) + String.fromCharCode(10), { mode: 0o600 })
    await writeDesktopRecord(env, record)
    return await statusDesktop(env)
  } catch (error) {
    if (child !== null) {
      await terminate(child.pid ?? null, KILL_GRACE_MS)
      const removal = await removeRuntimeRoot(paths.runtimeRoot, env)
      await clearDesktopRecord(env).catch(() => {})
      throw startFailure(error, paths, removal)
    }
    await removeRuntimeRoot(paths.runtimeRoot, env)
    throw asDesktopError(error, ErrorCode.DESKTOP_FAILED, 'The desktop could not be started')
  }
}

/**
 * Stop a recorded desktop.
 *
 * An `agent` desktop is terminated through its process group and its runtime
 * root is removed; the record is kept with state `closed` and the pid for
 * history. An `external` desktop is never killed: only its record is dropped.
 * @param options Environment and how long to wait after SIGTERM.
 * @returns What was stopped or forgotten, and whether the runtime root is gone.
 */
export async function stopDesktop(
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<DesktopStopReport> {
  const env = options.env ?? process.env
  const paths = desktopPaths(env)
  const read = await readDesktopRecord(env)
  const record = read.record
  if (record === null) {
    return {
      state: 'absent',
      signature: null,
      runtimeDir: paths.runtimeRoot,
      removed: false,
      detail: read.warnings[0] ?? null,
    }
  }
  if (record.target === 'external') {
    await clearDesktopRecord(env)
    return {
      state: 'forgotten',
      signature: record.signature,
      runtimeDir: record.runtimeDir,
      removed: false,
      detail: 'the external desktop was left running; only its record was removed',
    }
  }
  // Never signal a recycled pid: the lock file records the compositor that
  // owns this instance, and a mismatch means the process is somebody else now.
  const lockOwner = lockOf(join(record.runtimeDir, 'hypr', record.signature))?.pid ?? null
  if (record.pid !== null && lockOwner !== null && lockOwner !== record.pid) {
    throw new HyprscopeError(ErrorCode.DESKTOP_FAILED,
      `Refusing to stop: the recorded pid ${record.pid} no longer owns instance ${record.signature}`,
      { recordedPid: record.pid, lockPid: lockOwner, signature: record.signature })
  }
  await terminate(record.pid, options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)
  const removal: RuntimeRemoval = resolve(record.runtimeDir) === resolve(paths.runtimeRoot)
    ? await removeRuntimeRoot(paths.runtimeRoot, env)
    : {
        removed: false,
        detail: `the record points at ${record.runtimeDir}, not the configured runtime root ${paths.runtimeRoot}; nothing was removed`,
      }
  try {
    await writeDesktopRecord(env, {
      ...record,
      state: 'closed',
      detail: 'stopped by hyprscope control desktop stop',
      updatedAt: new Date().toISOString(),
    })
  } catch (error) {
    throw asDesktopError(error, ErrorCode.DESKTOP_FAILED, 'The desktop record could not be updated')
  }
  // Closing the desktop ends control inside it. The holder would otherwise keep
  // the lease until its TTL, and a restart gets a new signature anyway.
  await releaseLease({
    action: 'panic', source: 'desktop-stop', env: { ...env, HYPRSCOPE_LEASE_SIGNATURE: record.signature },
    waitMs: 2_000,
  }).catch(() => {})
  return {
    state: 'stopped',
    signature: record.signature,
    runtimeDir: record.runtimeDir,
    removed: removal.removed,
    detail: removal.detail,
  }
}

/**
 * Choose the Wayland display for an external instance.
 * @param runtimeDir External runtime directory.
 * @param instanceDir The instance's socket directory.
 * @returns Display basename whose socket exists, or null.
 */
function externalWaylandDisplay(runtimeDir: string, instanceDir: string): string | null {
  const locked = lockOf(instanceDir)?.waylandDisplay ?? null
  if (locked !== null && WAYLAND_DISPLAY_PATTERN.test(locked) && isSocket(join(runtimeDir, locked))) return locked
  return newestWaylandSocket(runtimeDir)
}

/**
 * Attach to an existing Hyprland instance the user named.
 *
 * The instance is verified through its control socket and a Wayland socket, and
 * its signature must not be the user's own desktop. The runtime directory is
 * never touched; only the record changes.
 * @param options Runtime directory, optional signature, consent, environment, and clock.
 * @returns Status of the attached desktop.
 * @throws HyprscopeError `USAGE` for a relative directory, an ambiguous instance,
 *   or the user's own signature; `TARGET_UNAVAILABLE` when nothing usable exists;
 *   `DESKTOP_FAILED` for the managed root or a different running desktop.
 */
export async function attachDesktop(options: {
  runtimeDir: string
  signature?: string
  consent?: 'chat' | 'card'
  consentNote?: string | null
  env?: NodeJS.ProcessEnv
  now?: () => Date
}): Promise<DesktopStatusReport> {
  const env = options.env ?? process.env
  const paths = desktopPaths(env)
  if (!isAbsolute(options.runtimeDir)) {
    throw new HyprscopeError(ErrorCode.USAGE,
      `The external desktop runtime directory must be absolute, got ${options.runtimeDir}`,
      { runtimeDir: options.runtimeDir })
  }
  const runtimeDir = resolve(options.runtimeDir)
  if (runtimeDir === resolve(paths.runtimeRoot)) {
    throw new HyprscopeError(ErrorCode.DESKTOP_FAILED,
      'That runtime directory belongs to the managed agent desktop; use desktop start (target agent) instead',
      { runtimeDir, target: 'agent', runtimeRoot: paths.runtimeRoot })
  }
  if (!isDirectory(runtimeDir)) {
    throw new HyprscopeError(ErrorCode.TARGET_UNAVAILABLE,
      `The external desktop runtime directory ${runtimeDir} does not exist`,
      { runtimeDir })
  }

  const instances = listInstanceDirs(runtimeDir)
  let signature = options.signature
  if (signature === undefined) {
    if (instances.length === 0) {
      throw new HyprscopeError(ErrorCode.TARGET_UNAVAILABLE,
        `No Hyprland instance with a control socket exists under ${join(runtimeDir, 'hypr')}`,
        { runtimeDir })
    }
    if (instances.length > 1) {
      throw new HyprscopeError(ErrorCode.USAGE,
        `More than one Hyprland instance is available under ${runtimeDir}; pass --signature`,
        { runtimeDir, signatures: instances.map(instance => instance.signature) })
    }
    signature = instances[0]?.signature
  }
  if (signature === undefined) {
    throw new HyprscopeError(ErrorCode.TARGET_UNAVAILABLE,
      `No Hyprland instance exists under ${runtimeDir}`, { runtimeDir })
  }
  if (!SIGNATURE_PATTERN.test(signature)) {
    throw new HyprscopeError(ErrorCode.USAGE, `Instance signature ${signature} is not a safe name`, { signature })
  }

  const instanceDir = join(runtimeDir, 'hypr', signature)
  if (!isSocket(join(instanceDir, '.socket.sock'))) {
    throw new HyprscopeError(ErrorCode.TARGET_UNAVAILABLE,
      `Instance ${signature} under ${runtimeDir} has no control socket`,
      { runtimeDir, signature })
  }
  const waylandDisplay = externalWaylandDisplay(runtimeDir, instanceDir)
  if (waylandDisplay === null) {
    throw new HyprscopeError(ErrorCode.TARGET_UNAVAILABLE,
      `Instance ${signature} under ${runtimeDir} has no Wayland socket`,
      { runtimeDir, signature })
  }

  // The user's own instance is the user target and needs a per-run card; a
  // record for it would invite a run to skip that card. Do not exclude it from
  // the scan: the scan is how its signature is recognised here.
  let hostSignature: string | null = null
  try { hostSignature = discoverSession({ env }).signature } catch { hostSignature = null }
  if (hostSignature === signature) {
    throw new HyprscopeError(ErrorCode.USAGE,
      `Instance ${signature} is the user's own desktop; omit --desktop external`,
      { signature, runtimeDir })
  }

  const existing = (await readDesktopRecord(env)).record
  if (existing !== null && existing.signature !== signature) {
    const current = await statusDesktop(env)
    if (current.state === 'running') {
      throw new HyprscopeError(ErrorCode.DESKTOP_FAILED,
        `The desktop ${existing.signature} is still running; stop the current desktop first`,
        { signature: existing.signature, target: existing.target, runtimeDir: existing.runtimeDir })
    }
  }

  const at = (options.now ?? defaultNow)().toISOString()
  try {
    await writeDesktopRecord(env, {
      schema: 1,
      target: 'external',
      state: 'running',
      runtimeDir,
      signature,
      waylandDisplay,
      pid: lockOf(instanceDir)?.pid ?? null,
      configDir: '',
      configHash: null,
      size: null,
      consent: consentRecord(options.consent, options.consentNote, DEFAULT_ATTACH_CONSENT_NOTE, at),
      createdAt: at,
      updatedAt: at,
      detail: null,
    })
  } catch (error) {
    throw asDesktopError(error, ErrorCode.DESKTOP_FAILED, 'The external desktop record could not be written')
  }
  return statusDesktop(env)
}
