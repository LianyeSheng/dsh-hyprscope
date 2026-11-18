/**
 * Reading, writing, and locating the desktop record.
 *
 * The record is a cache of what the tool started, never an authority: every
 * consumer re-checks the pid and the sockets before believing it. Paths are
 * resolved here so the lifecycle and the target resolver cannot disagree.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import { defaultRuntimeDir } from '../session.ts'
import type { DesktopRecord, DesktopState } from './types.ts'

/** Longest path a unix socket may have, including the terminator. */
export const MAX_UNIX_SOCKET_PATH = 107

/** Every path one installation uses for its managed desktop. */
export interface DesktopPaths {
  /** Persistent state root. */
  stateDir: string
  recordFile: string
  /** Generated configuration root; `configDir/hypr/hyprland.lua` is the entry file. */
  configDir: string
  snippetsDir: string
  logsDir: string
  logFile: string
  /** Per-signature baselines. */
  baselinesDir: string
  /** Short runtime root; everything here is disposable. */
  runtimeRoot: string
  pidFile: string
}

/**
 * Resolve the desktop paths.
 * @param env Environment that owns the state and runtime directories.
 * @returns Absolute paths; the runtime root may be overridden for tests.
 */
export function desktopPaths(env: NodeJS.ProcessEnv = process.env): DesktopPaths {
  const stateHome = env.XDG_STATE_HOME || join(env.HOME ?? '.', '.local', 'state')
  const stateDir = join(stateHome, 'hyprscope', 'desktop')
  const runtimeRoot = env.HYPRSCOPE_DESKTOP_RUNTIME_DIR ?? join(defaultRuntimeDir(env), 'hs')
  if (!isAbsolute(runtimeRoot)) {
    throw new HyprscopeError(ErrorCode.USAGE, 'The desktop runtime root must be an absolute path', { runtimeRoot })
  }
  return {
    stateDir,
    recordFile: join(stateDir, 'desktop.json'),
    configDir: join(stateDir, 'config'),
    snippetsDir: join(stateDir, 'config', 'hypr', 'agent'),
    logsDir: join(stateDir, 'logs'),
    logFile: join(stateDir, 'logs', 'desktop.log'),
    baselinesDir: join(stateDir, 'baseline'),
    runtimeRoot,
    pidFile: join(runtimeRoot, 'desktop.pid'),
  }
}

/**
 * Predict the longest socket path a signature will produce.
 * @param runtimeRoot Runtime root the compositor will use.
 * @param signatureLength Signature length; Hyprland's is 61 characters.
 * @returns Path length of the event socket.
 */
export function socketPathLength(runtimeRoot: string, signatureLength = 61): number {
  return join(runtimeRoot, 'hypr', 'x'.repeat(signatureLength), '.socket2.sock').length
}

/**
 * Fail before starting when the runtime root would make sockets unaddressable.
 * @param runtimeRoot Runtime root the compositor will use.
 * @throws HyprscopeError when the event socket path exceeds the unix limit.
 */
export function assertRuntimeRoot(runtimeRoot: string): void {
  const length = socketPathLength(runtimeRoot)
  if (length > MAX_UNIX_SOCKET_PATH) {
    throw new HyprscopeError(ErrorCode.DESKTOP_FAILED,
      `The desktop runtime root ${runtimeRoot} is too long: its event socket would be ${length} bytes, over the ${MAX_UNIX_SOCKET_PATH}-byte unix limit`,
      { runtimeRoot, pathLength: length, limit: MAX_UNIX_SOCKET_PATH })
  }
}

/** Result of reading the record. */
export interface DesktopRecordRead {
  record: DesktopRecord | null
  warnings: string[]
  path: string
}

/**
 * Read and validate `desktop.json`.
 * @param env Environment that owns the state directory.
 * @returns Record, or null with the reason in `warnings`.
 */
export async function readDesktopRecord(env: NodeJS.ProcessEnv = process.env): Promise<DesktopRecordRead> {
  const paths = desktopPaths(env)
  let text: string
  try {
    text = await readFile(paths.recordFile, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { record: null, warnings: [], path: paths.recordFile }
    return { record: null, warnings: [`the desktop record could not be read (${code ?? 'unknown error'})`], path: paths.recordFile }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { record: null, warnings: ['the desktop record is not JSON'], path: paths.recordFile }
  }
  const record = parseDesktopRecord(parsed)
  return record === null
    ? { record: null, warnings: ['the desktop record is not a usable desktop'], path: paths.recordFile }
    : { record, warnings: [], path: paths.recordFile }
}

/**
 * Parse one record defensively.
 * @param value Parsed JSON.
 * @returns Record, or null when a required field is missing.
 */
export function parseDesktopRecord(value: unknown): DesktopRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const target = record.target
  const state = record.state
  if (record.schema !== 1) return null
  if (target !== 'agent' && target !== 'external') return null
  if (state !== 'running' && state !== 'closed' && state !== 'stale') return null
  if (typeof record.runtimeDir !== 'string' || !isAbsolute(record.runtimeDir)) return null
  if (typeof record.signature !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.signature)) return null
  if (typeof record.waylandDisplay !== 'string' || record.waylandDisplay === '') return null
  const consent = typeof record.consent === 'object' && record.consent !== null
    ? record.consent as Record<string, unknown>
    : null
  if (consent === null || (consent.source !== 'chat' && consent.source !== 'card') || typeof consent.at !== 'string') return null
  const iso = (field: unknown): string => typeof field === 'string' && field !== '' ? field : new Date(0).toISOString()
  return {
    schema: 1,
    target,
    state,
    runtimeDir: record.runtimeDir,
    signature: record.signature,
    waylandDisplay: record.waylandDisplay,
    pid: typeof record.pid === 'number' && Number.isSafeInteger(record.pid) ? record.pid : null,
    configDir: typeof record.configDir === 'string' ? record.configDir : '',
    configHash: typeof record.configHash === 'string' && record.configHash !== '' ? record.configHash : null,
    size: typeof record.size === 'string' ? record.size : null,
    consent: {
      source: consent.source,
      at: iso(consent.at),
      note: typeof consent.note === 'string' ? consent.note : null,
    },
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
    detail: typeof record.detail === 'string' ? record.detail : null,
  }
}

/**
 * Write the record atomically with `0600`.
 * @param env Environment that owns the state directory.
 * @param record Record to persist.
 */
export async function writeDesktopRecord(env: NodeJS.ProcessEnv, record: DesktopRecord): Promise<void> {
  const paths = desktopPaths(env)
  await mkdir(dirname(paths.recordFile), { recursive: true, mode: 0o700 })
  const temporary = `${paths.recordFile}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, paths.recordFile)
}

/**
 * Remove the record; a missing file is not an error.
 * @param env Environment that owns the state directory.
 */
export async function clearDesktopRecord(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await rm(desktopPaths(env).recordFile, { force: true })
}

/** @param state Candidate state. @returns Whether it is a known state. */
export function isDesktopState(state: string): state is DesktopState {
  return state === 'running' || state === 'closed' || state === 'stale'
}
