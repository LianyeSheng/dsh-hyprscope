/** Spawn the Quickshell overlay that renders the desktop-message hint and composer. */
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import { overlayDirectory } from '../paths.ts'
import type { Session } from '../types.ts'
import type { RenderLanguage } from '../i18n.ts'
import { ensureMessageDirectory, messagePaths, type MessagePaths } from './state.ts'

/** What one ensure call did. */
export interface MessageOverlayHandle {
  /** Pid of the spawned process; null when the spawn reported none. */
  pid: number | null
  /** Log file the overlay writes to. */
  log: string
  /** Message directory the overlay was pointed at. */
  dir: string
}

/**
 * @returns Absolute directory of the desktop-message Quickshell configuration.
 */
export function messageOverlayDirectory(): string {
  return join(overlayDirectory(), 'message')
}

/**
 * Start the desktop-message overlay when it is not already running.
 *
 * `quickshell -n` makes this idempotent: a second invocation exits by itself
 * when an instance of the same configuration is already up, so the caller never
 * has to track a pid or a lock. The overlay only polls files; the spawned child
 * is detached and its output goes to `overlay.log`.
 * @param session Discovered Hyprland session the overlay should render on.
 * @param options Environment, render language and resolved paths.
 * @returns Handle facts for the caller's report.
 */
export async function ensureMessageOverlay(
  session: Session,
  options: { env?: NodeJS.ProcessEnv; lang?: RenderLanguage; paths?: MessagePaths } = {},
): Promise<MessageOverlayHandle> {
  const env = options.env ?? process.env
  const paths = options.paths ?? messagePaths()
  await ensureMessageDirectory(paths)
  const display = session.waylandDisplay ?? (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY !== ''
    ? env.WAYLAND_DISPLAY
    : null)
  if (display === null) {
    throw new HyprscopeError(ErrorCode.OVERLAY_FAILED, 'The desktop-message overlay needs a Wayland display', {
      session: session.signature,
      hint: 'run this command from the graphical session, or pass --runtime-dir/--signature so discovery finds the display',
    })
  }
  const binary = env.HYPRSCOPE_QUICKSHELL !== undefined && env.HYPRSCOPE_QUICKSHELL !== ''
    ? env.HYPRSCOPE_QUICKSHELL
    : 'quickshell'
  const logFd = openSync(paths.overlayLog, 'a', 0o600)
  let child
  try {
    child = spawn(binary, ['-p', messageOverlayDirectory(), '-n'], {
      detached: true,
      env: {
        ...env,
        WAYLAND_DISPLAY: display,
        XDG_RUNTIME_DIR: session.runtimeDir,
        HYPRSCOPE_MESSAGE_DIR: paths.dir,
        HYPRSCOPE_MESSAGE_LANG: options.lang ?? 'zh',
      },
      stdio: ['ignore', 'ignore', logFd],
    })
  } catch (error) {
    throw overlayFailure(binary, paths, error)
  } finally {
    closeSync(logFd)
  }
  child.unref()
  const pid = child.pid ?? null
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => { resolve() })
      child.once('error', reject)
    })
  } catch (error) {
    throw overlayFailure(binary, paths, error)
  }
  // A tracked error after spawn must not crash the caller: the overlay is a
  // best-effort surface and `message open` still reports the request it wrote.
  child.on('error', () => {})
  return { pid, log: paths.overlayLog, dir: paths.dir }
}

/**
 * @param binary Quickshell binary that failed to start.
 * @param paths Message paths for the report.
 * @param error Spawn failure.
 * @returns Coded failure with the repair step and the log path.
 */
function overlayFailure(binary: string, paths: MessagePaths, error: unknown): HyprscopeError {
  return new HyprscopeError(ErrorCode.OVERLAY_FAILED, `Cannot start the desktop-message overlay (${binary})`, {
    binary,
    log: paths.overlayLog,
    hint: 'install quickshell, or point HYPRSCOPE_QUICKSHELL at the binary',
    cause: error instanceof Error ? error.message : String(error),
  })
}
