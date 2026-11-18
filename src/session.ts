/** Locate the running Hyprland instance without inheriting a graphical session environment. */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ErrorCode, HyprscopeError } from './errors.ts'
import type { DiscoverSessionOptions, InstanceDirectory, Session } from './types.ts'

const WAYLAND_SOCKET = /^wayland-\d+$/

/**
 * Resolve the runtime directory that owns the compositor sockets.
 * @param env Environment to read.
 * @returns Absolute runtime directory.
 */
export function defaultRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR !== '') return env.XDG_RUNTIME_DIR
  const uid = process.getuid?.()
  if (uid === undefined) {
    throw new HyprscopeError(ErrorCode.NO_SESSION, 'XDG_RUNTIME_DIR is unset and the user id is unavailable')
  }
  return `/run/user/${uid}`
}

/**
 * @param path Candidate socket path.
 * @returns Whether the path is a unix socket.
 */
function isSocket(path: string): boolean {
  try { return statSync(path).isSocket() } catch { return false }
}

/**
 * @param path File path.
 * @returns Modification time in milliseconds, or 0 when missing.
 */
function modifiedAt(path: string): number {
  try { return statSync(path).mtimeMs } catch { return 0 }
}

/** Lock-file contents written by Hyprland. */
export interface InstanceLock {
  pid: number | null
  waylandDisplay: string | null
}

/**
 * Read the pid and Wayland display Hyprland writes into its lock file.
 * @param instanceDir Per-instance socket directory.
 * @returns Parsed lock contents; unknown fields are null.
 */
export function readLock(instanceDir: string): InstanceLock {
  const text = readFileSync(join(instanceDir, 'hyprland.lock'), 'utf8')
  const [pidLine = '', displayLine = ''] = text.split('\n').map(line => line.trim())
  const pid = Number.parseInt(pidLine, 10)
  return { pid: Number.isSafeInteger(pid) ? pid : null, waylandDisplay: displayLine !== '' ? displayLine : null }
}

/**
 * Enumerate per-instance directories that expose a Hyprland control socket.
 * @param runtimeDir Runtime directory containing `hypr/`.
 * @returns Instances, most recently active first.
 */
export function listInstanceDirs(runtimeDir: string): InstanceDirectory[] {
  const root = join(runtimeDir, 'hypr')
  let names: string[]
  try { names = readdirSync(root) } catch { return [] }
  return names
    .map((signature): InstanceDirectory => {
      const dir = join(root, signature)
      return {
        signature,
        dir,
        hasControl: isSocket(join(dir, '.socket.sock')),
        hasEvents: isSocket(join(dir, '.socket2.sock')),
        logMtimeMs: modifiedAt(join(dir, 'hyprland.log')),
        lockMtimeMs: modifiedAt(join(dir, 'hyprland.lock')),
      }
    })
    .filter(instance => instance.hasControl)
    .sort((a, b) => (b.logMtimeMs || b.lockMtimeMs) - (a.logMtimeMs || a.lockMtimeMs))
}

/**
 * Find the most recently created Wayland session socket.
 * @param runtimeDir Runtime directory containing `wayland-N` sockets.
 * @returns Socket basename, or null when none exists.
 */
export function newestWaylandSocket(runtimeDir: string): string | null {
  let names: string[]
  try { names = readdirSync(runtimeDir) } catch { return null }
  const sockets = names
    .filter(name => WAYLAND_SOCKET.test(name) && isSocket(join(runtimeDir, name)))
    .sort((a, b) => modifiedAt(join(runtimeDir, b)) - modifiedAt(join(runtimeDir, a)))
  return sockets[0] ?? null
}

/**
 * Select one Hyprland instance and the Wayland display that belongs to it.
 *
 * Discovery scans `$XDG_RUNTIME_DIR/hypr` because a Harness process started outside the
 * graphical session inherits neither `WAYLAND_DISPLAY` nor `HYPRLAND_INSTANCE_SIGNATURE`.
 * @param options Explicit overrides for scripts and tests.
 * @returns Discovered session.
 */
export function discoverSession(options: DiscoverSessionOptions = {}): Session {
  const env = options.env ?? process.env
  const runtimeDir = options.runtimeDir ?? env.HYPRSCOPE_RUNTIME_DIR ?? defaultRuntimeDir(env)
  const requested = options.signature ?? env.HYPRSCOPE_SIGNATURE ?? env.HYPRLAND_INSTANCE_SIGNATURE
  const instances = listInstanceDirs(runtimeDir)
    .filter(instance => instance.signature !== options.excludeSignature)
  if (instances.length === 0) {
    throw new HyprscopeError(ErrorCode.NO_SESSION, `No running Hyprland instance under ${join(runtimeDir, 'hypr')}`, { runtimeDir })
  }
  const instance = requested === undefined
    ? instances[0]
    : instances.find(candidate => candidate.signature === requested)
  if (instance === undefined) {
    throw new HyprscopeError(ErrorCode.NO_SESSION, `Hyprland instance ${requested} is not running`, {
      runtimeDir, running: instances.map(candidate => candidate.signature),
    })
  }
  let pid: number | null = null
  let lockDisplay: string | null = null
  try {
    ;({ pid, waylandDisplay: lockDisplay } = readLock(instance.dir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const explicitDisplay = options.waylandDisplay ?? env.HYPRSCOPE_WAYLAND_DISPLAY
  if (explicitDisplay !== undefined && !isSocket(join(runtimeDir, explicitDisplay))) {
    throw new HyprscopeError(ErrorCode.NO_SESSION, `Requested Wayland display ${explicitDisplay} has no socket`, {
      runtimeDir, requested: explicitDisplay,
    })
  }
  const candidates: Array<{ value: string | undefined; source: Session['waylandDisplaySource'] }> = [
    { value: explicitDisplay, source: 'override' },
    { value: lockDisplay ?? undefined, source: 'lock' },
    { value: env.WAYLAND_DISPLAY, source: 'environment' },
    { value: newestWaylandSocket(runtimeDir) ?? undefined, source: 'socket-scan' },
  ]
  const chosen = candidates.find(candidate => candidate.value !== undefined
    && isSocket(join(runtimeDir, candidate.value)))
  const waylandDisplay = chosen?.value ?? null
  return {
    runtimeDir,
    signature: instance.signature,
    instanceDir: instance.dir,
    pid,
    waylandDisplay,
    waylandSocket: waylandDisplay === null ? null : join(runtimeDir, waylandDisplay),
    controlSocket: join(instance.dir, '.socket.sock'),
    eventSocket: join(instance.dir, '.socket2.sock'),
    source: requested === undefined ? 'scan' : 'explicit',
    instanceCount: instances.length,
    inherited: {
      waylandDisplay: env.WAYLAND_DISPLAY !== undefined,
      signature: env.HYPRLAND_INSTANCE_SIGNATURE !== undefined,
    },
    waylandDisplaySource: chosen?.source ?? 'none',
  }
}
