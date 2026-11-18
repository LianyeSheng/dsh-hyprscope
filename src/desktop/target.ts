/**
 * Resolving a desktop selector to one observable session.
 *
 * Three targets exist: the user's own Hyprland (`user`, the default), a nested
 * desktop the tool started (`agent`), and an instance the user attached
 * (`external`). The last two are recorded in `desktop.json`, but the record is
 * a cache and never an authority: every resolution re-checks the recorded pid
 * and sockets before discovery. See `docs/DESKTOP.md` §2.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { baselinePaths, type BaselinePaths } from '../compat/baseline.ts'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import { processAlive } from '../process.ts'
import { defaultRuntimeDir, discoverSession, listInstanceDirs } from '../session.ts'
import type { Session } from '../types.ts'
import { readDesktopRecord } from './record.ts'
import type { DesktopRecord, DesktopTarget, ResolvedTarget } from './types.ts'

/** Inputs that select the environment and override a previously read record. */
export interface ResolveTargetOptions {
  /** Environment that owns the state and runtime directories; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Explicit instance signature from `--signature`; it disables managed-desktop exclusion. */
  signature?: string
  /** Runtime directory override, mainly for tests and scripts. */
  runtimeDir?: string
  /** Pre-read record; when omitted or `null`, `desktop.json` is read instead. */
  record?: DesktopRecord | null
}

/**
 * Parse a `--desktop` selector.
 * @param value Raw selector; `undefined` and the empty string mean the default.
 * @returns The selected target.
 * @throws HyprscopeError with `USAGE` when the value is not a known target.
 */
export function parseDesktopTarget(value: string | undefined): DesktopTarget {
  if (value === undefined || value === '' || value === 'user') return 'user'
  if (value === 'agent' || value === 'external') return value
  throw new HyprscopeError(ErrorCode.USAGE, `Unknown desktop ${value}; expected user, agent, or external`, { value })
}

/**
 * Locate the capability baseline that belongs to one target.
 *
 * The user's desktop keeps the machine-wide baseline; a nested or external
 * instance is keyed by its signature, so a probe of one desktop can never gate
 * another.
 * @param env Environment that owns the state directory.
 * @param target Desktop selector.
 * @param signature Instance signature; required for `agent` and `external`.
 * @returns Absolute baseline paths for the selected desktop.
 * @throws HyprscopeError with `USAGE` when a non-user target has no signature.
 */
export function baselinePathsForTarget(
  env: NodeJS.ProcessEnv,
  target: DesktopTarget,
  signature: string | null,
): BaselinePaths {
  if (target === 'user') return baselinePaths(env)
  if (signature === null || signature === '') {
    throw new HyprscopeError(
      ErrorCode.USAGE,
      `The ${target} desktop has no instance signature, so its capability baseline cannot be located`,
      { target },
    )
  }
  return baselinePaths(env, { signature })
}

/**
 * Resolve one desktop selector to the session it addresses.
 *
 * The record is read at most once, before the target decides whether it needs
 * it: the default target excludes the recorded instance so a running agent
 * desktop can never silently become the user's desktop.
 * @param target Desktop selector, normally from {@link parseDesktopTarget}.
 * @param options Environment and test overrides.
 * @returns The resolved session plus the baseline keys and environment it needs.
 * @throws HyprscopeError with `NO_SESSION` when nothing matches, or
 * `TARGET_UNAVAILABLE` when only a managed desktop is running or the record is
 * stale.
 */
export async function resolveTarget(
  target: DesktopTarget,
  options: ResolveTargetOptions = {},
): Promise<ResolvedTarget> {
  const env = options.env ?? process.env
  const record = options.record ?? (await readDesktopRecord(env)).record
  return target === 'user'
    ? resolveUser(env, options, record)
    : resolveManaged(target, env, record)
}

/**
 * Resolve the user's own desktop, skipping the recorded managed instance.
 * @param env Environment passed to discovery.
 * @param options Selector overrides.
 * @param record Record read for the exclusion, if any.
 * @returns The user target with no baseline key beyond the machine-wide file.
 * @throws HyprscopeError when discovery fails, with a hint when only the managed desktop runs.
 */
function resolveUser(env: NodeJS.ProcessEnv, options: ResolveTargetOptions, record: DesktopRecord | null): ResolvedTarget {
  const excludeSignature = options.signature === undefined ? record?.signature : undefined
  let session: Session
  try {
    session = discoverSession({
      env,
      runtimeDir: options.runtimeDir,
      signature: options.signature,
      excludeSignature,
    })
  } catch (error) {
    if (error instanceof HyprscopeError && error.code === ErrorCode.NO_SESSION
      && record !== null && excludeSignature !== undefined
      && onlyInstanceIs(env, options.runtimeDir, excludeSignature)) {
      const hint = record.target === 'agent'
        ? 'only the managed agent desktop is running; pass --desktop agent'
        : 'only the attached external desktop is running; pass --desktop external'
      throw new HyprscopeError(ErrorCode.TARGET_UNAVAILABLE, `The user desktop is not running: ${hint}`, {
        target: 'user',
        managedTarget: record.target,
        managedSignature: record.signature,
      })
    }
    throw error
  }
  return {
    target: 'user',
    session,
    desktop: null,
    signature: session.signature,
    baselineSignature: null,
    configHash: null,
    env,
  }
}

/**
 * Resolve a recorded `agent` or `external` desktop.
 * @param target Recorded target to use.
 * @param env Environment passed to discovery.
 * @param record Record read once by {@link resolveTarget}.
 * @returns The recorded session with its baseline keys and lease environment.
 * @throws HyprscopeError with `TARGET_UNAVAILABLE` when no matching live desktop exists.
 */
function resolveManaged(
  target: 'agent' | 'external',
  env: NodeJS.ProcessEnv,
  record: DesktopRecord | null,
): ResolvedTarget {
  if (record === null || record.target !== target) {
    throw new HyprscopeError(
      ErrorCode.TARGET_UNAVAILABLE,
      target === 'agent'
        ? 'No agent desktop is running; run hyprscope control desktop start'
        : 'No external desktop is attached; run hyprscope control desktop attach',
      { target, recordedTarget: record?.target ?? null },
    )
  }
  const reason = staleReason(record)
  if (reason !== null) {
    throw new HyprscopeError(
      ErrorCode.TARGET_UNAVAILABLE,
      `The ${target} desktop is unavailable: the desktop is closed/stale (${reason}); `
        + (target === 'agent' ? 'run hyprscope control desktop start to create a new one' : 'run hyprscope control desktop attach to attach it again'),
      { target, signature: record.signature, reason, detail: 'the desktop is closed/stale' },
    )
  }
  const session = discoverSession({ env, runtimeDir: record.runtimeDir, signature: record.signature })
  return {
    target,
    session,
    desktop: record,
    signature: session.signature,
    baselineSignature: record.signature,
    configHash: record.configHash,
    env: { ...env, HYPRSCOPE_LEASE_SIGNATURE: record.signature },
  }
}

/**
 * Decide whether discovery's empty scan is explained by the excluded instance.
 * @param env Environment that owns the runtime directory.
 * @param runtimeDir Explicit runtime directory, when the caller gave one.
 * @param signature Excluded instance signature.
 * @returns Whether the only discovered instance is the excluded one.
 */
function onlyInstanceIs(env: NodeJS.ProcessEnv, runtimeDir: string | undefined, signature: string): boolean {
  const root = runtimeDir ?? env.HYPRSCOPE_RUNTIME_DIR ?? defaultRuntimeDir(env)
  const instances = listInstanceDirs(root)
  return instances.length > 0 && instances.every(instance => instance.signature === signature)
}

/**
 * Explain why a record no longer describes a live desktop.
 * @param record Record to verify.
 * @returns One reason a human can act on, or null when every fact checks out.
 */
function staleReason(record: DesktopRecord): string | null {
  if (record.state !== 'running') return `the record says it is ${record.state}`
  const instanceDir = join(record.runtimeDir, 'hypr', record.signature)
  if (!pathExists(instanceDir)) return `its instance directory ${instanceDir} is missing`
  const controlSocket = join(instanceDir, '.socket.sock')
  if (!isSocket(controlSocket)) return `its control socket ${controlSocket} is missing`
  const waylandSocket = join(record.runtimeDir, record.waylandDisplay)
  if (!pathExists(waylandSocket)) return `its Wayland socket ${waylandSocket} is missing`
  if (record.pid !== null && !processAlive(record.pid)) return `its compositor process ${record.pid} is gone`
  return null
}

/**
 * @param path Candidate path.
 * @returns Whether the path can be stat'ed.
 */
function pathExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * @param path Candidate socket path.
 * @returns Whether the path is a unix socket.
 */
function isSocket(path: string): boolean {
  try {
    return statSync(path).isSocket()
  } catch {
    return false
  }
}
