/** Optional Wayland capability probe built from `probe/wl-globals.c`. */
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ErrorCode, HyprscopeError } from './errors.ts'
import { binDir } from './paths.ts'
import type { Session, WaylandGlobal, WaylandProbe } from './types.ts'

const run = promisify(execFile)

/** Capabilities reported from the registry probe. */
export type WaylandCapabilities = WaylandProbe['capabilities']

/**
 * Absolute path of the compiled probe binary.
 * @returns Path under the package `bin/` directory.
 */
export function probeBinaryPath(): string {
  return join(binDir(), 'wl-globals')
}

/**
 * Parse probe output into globals and the seat count.
 * @param text Standard output of the probe.
 * @returns Probe result.
 */
export function parseGlobals(text: string): { seatCount: number | null; globals: WaylandGlobal[] } {
  const globals: WaylandGlobal[] = []
  let seatCount: number | null = null
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const [name = '', value = ''] = line.split('\t')
    if (name === 'seat-count') { seatCount = Number.parseInt(value, 10); continue }
    const version = Number.parseInt(value, 10)
    if (Number.isInteger(version)) globals.push({ interface: name, version })
  }
  return { seatCount, globals }
}

/**
 * Report which Wayland interfaces the running compositor exposes.
 * @param session Session with a known Wayland display.
 * @param options Limits and binary override.
 * @returns Global interfaces plus protocol presence.
 */
export async function probeWaylandGlobals(
  session: Session,
  options: { timeoutMs?: number; binary?: string } = {},
): Promise<WaylandProbe> {
  const binary = options.binary ?? probeBinaryPath()
  if (!existsSync(binary)) {
    throw new HyprscopeError(ErrorCode.COMMAND_FAILED, 'Wayland probe is not built', {
      binary, hint: 'Run: pnpm run build:probe',
    })
  }
  if (session.waylandDisplay === null) {
    throw new HyprscopeError(ErrorCode.COMMAND_FAILED, 'No Wayland display was discovered for this session')
  }
  let stdout: string
  try {
    ;({ stdout } = await run(binary, [], {
      env: { ...process.env, XDG_RUNTIME_DIR: session.runtimeDir, WAYLAND_DISPLAY: session.waylandDisplay },
      timeout: options.timeoutMs ?? 5000, maxBuffer: 1024 * 1024, encoding: 'utf8',
    }))
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    throw new HyprscopeError(ErrorCode.COMMAND_FAILED, 'Wayland probe failed', {
      stderr: typeof failure.stderr === 'string' ? failure.stderr.trim() : '',
    })
  }
  const { seatCount, globals } = parseGlobals(stdout)
  const has = (name: string): boolean | null => globals.some(global => global.interface === name) ? true : null
  return {
    seatCount,
    globals,
    capabilities: {
      virtualKeyboard: has('zwp_virtual_keyboard_manager_v1'),
      virtualPointer: has('zwlr_virtual_pointer_manager_v1'),
      screencopy: has('zwlr_screencopy_manager_v1'),
      imageCopyCapture: has('ext_image_copy_capture_manager_v1'),
      foreignToplevel: has('zwlr_foreign_toplevel_manager_v1'),
      workspaceManager: has('ext_workspace_manager_v1'),
      idleNotifier: has('ext_idle_notifier_v1'),
      sessionLock: has('ext_session_lock_manager_v1'),
      pointerWarp: has('wp_pointer_warp_v1'),
    },
  }
}
