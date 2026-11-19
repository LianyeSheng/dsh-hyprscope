/** Consent and control overlay process, rendered by Quickshell. */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync } from 'node:fs'
import { join, sep } from 'node:path'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import { binDir, overlayDirectory as resolveOverlayDirectory, packageRoot } from '../paths.ts'
import type { RenderLanguage } from '../i18n.ts'
import { discoverSession } from '../session.ts'
import { ensureLeaseDirectory, type LeasePaths, type LeaseState } from './state.ts'

/** A running overlay that can be stopped and observed. */
export interface OverlayHandle {
  pid: number | null
  exited: Promise<void>
  stop(): Promise<void>
}

/** Creates the overlay; tests replace it with a fake. */
export type OverlayFactory = (paths: LeasePaths, state: LeaseState) => Promise<OverlayHandle>

/**
 * @returns Absolute path of the QML overlay directory.
 */
export function overlayDirectory(): string {
  return resolveOverlayDirectory()
}

/**
 * Pick the entry point Node can actually execute.
 *
 * A checkout keeps its sources in `.ts` and Node runs them directly, so the
 * source wins there and a stale emitted `.js` never shadows a fresh edit. An
 * installed package lives under `node_modules`, where Node refuses to strip
 * types, so the emitted entry under `dist/` is the only runnable file:
 * `dist/bin/hyprscope.js`.
 *
 * @param tsPath Absolute path of the TypeScript entry.
 * @param jsPath Absolute path of the emitted JavaScript entry.
 * @returns The path to spawn.
 */
export function preferredEntry(tsPath: string, jsPath: string): string {
  if (tsPath.split(sep).includes('node_modules')) return existsSync(jsPath) ? jsPath : tsPath
  return existsSync(tsPath) ? tsPath : jsPath
}

/**
 * @returns Absolute path of the `hyprscope` entry point the overlay invokes.
 */
export function hyprscopeBin(): string {
  return preferredEntry(
    join(binDir(), 'hyprscope.ts'),
    join(packageRoot(), 'dist', 'bin', 'hyprscope.js'),
  )
}

/** @param ms Delay in milliseconds. */
const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * Add the graphical session variables a quickshell child needs when the Harness
 * process itself was started outside the compositor's environment.
 * @param env Inherited environment.
 * @returns Environment that can reach the running compositor.
 */
function overlayEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.WAYLAND_DISPLAY !== undefined) return env
  try {
    const session = discoverSession({ env })
    if (session.waylandDisplay === null) return env
    return { ...env, WAYLAND_DISPLAY: session.waylandDisplay, XDG_RUNTIME_DIR: session.runtimeDir }
  } catch {
    return env
  }
}

/**
 * Start the Quickshell overlay that shows the consent card and the lease banner.
 * @param paths Lease state paths.
 * @param state Lease state passed for the first render.
 * @param options Environment and binary overrides.
 * @returns Handle that owns the child process.
 */
export async function startOverlay(
  paths: LeasePaths,
  state: LeaseState,
  options: { env?: NodeJS.ProcessEnv; lang?: RenderLanguage } = {},
): Promise<OverlayHandle> {
  const env = options.env ?? process.env
  await ensureLeaseDirectory(paths)
  const binary = env.HYPRSCOPE_QUICKSHELL ?? 'quickshell'
  // The overlay outlives the requester: it renders the result during its linger
  // window after control returns. Give the child its own log fd and detach it so
  // a parent exit cannot close a pipe under it (SIGPIPE used to kill the banner
  // right when the run finished).
  const logFd = openSync(paths.overlayLog, 'a', 0o600)
  const child = spawn(binary, ['-p', overlayDirectory(), '-n'], {
    detached: true,
    env: {
      ...overlayEnvironment(env),
      HYPRSCOPE_STATE: paths.stateFile,
      HYPRSCOPE_NOTICE: paths.noticeFile,
      HYPRSCOPE_PROGRESS: paths.progressFile,
      HYPRSCOPE_INTERFERENCE: paths.interferenceFile,
      HYPRSCOPE_ANSWER: paths.answerFile,
      HYPRSCOPE_INTERFERENCE_ANSWER: paths.interferenceAnswerFile,
      HYPRSCOPE_BIN: hyprscopeBin(),
      HYPRSCOPE_NODE: process.execPath,
      HYPRSCOPE_LANG: options.lang ?? 'zh',
    },
    stdio: ['ignore', 'ignore', logFd],
  })
  closeSync(logFd)
  child.unref()
  const exited = new Promise<void>(resolve => {
    child.once('exit', () => resolve())
    child.once('error', () => resolve())
  })
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', reject)
    })
  } catch (error) {
    throw new HyprscopeError(ErrorCode.OVERLAY_FAILED, `Cannot start the overlay (${binary})`, {
      binary, state: state.phase, cause: error instanceof Error ? error.message : String(error),
    })
  }
  return {
    pid: child.pid ?? null,
    exited,
    async stop(): Promise<void> {
      child.kill('SIGTERM')
      await Promise.race([exited, delay(800)])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await Promise.race([exited, delay(400)])
    },
  }
}

/**
 * Confirm a recorded pid still belongs to the overlay before signalling it.
 * @param pid Candidate overlay pid.
 * @returns Whether `/proc` reports a Quickshell process.
 */
async function looksLikeOverlay(pid: number): Promise<boolean> {
  try {
    const { readFile } = await import('node:fs/promises')
    const comm = (await readFile(`/proc/${pid}/comm`, 'utf8')).trim().toLowerCase()
    return comm === 'quickshell' || comm === 'qs'
  } catch {
    return false
  }
}

/**
 * Stop an overlay started by another process.
 * @param pid Overlay pid recorded in the lease state.
 * @returns Completion after the process is gone or the grace period elapsed.
 */
export async function stopOverlayPid(pid: number | null): Promise<void> {
  if (pid === null || pid <= 0 || pid === process.pid) return
  if (!(await looksLikeOverlay(pid))) return
  try { process.kill(pid, 'SIGTERM') } catch { return }
  await delay(700)
  try { process.kill(pid, 0); process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
}
