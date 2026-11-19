/**
 * Capture one foreign toplevel through the native `wl-capture` helper.
 *
 * Unlike grim (wlr-screencopy), which can only copy the composited output, this
 * path asks the compositor to render a single toplevel into a buffer, so a
 * window that sits on another workspace or is covered by another window can
 * still be captured. The helper writes raw RGBA; PNG framing and orientation
 * are handled here so the helper needs only wayland-client.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { ErrorCode, HyprscopeError } from './errors.ts'
import { binDir } from './paths.ts'
import { encodePng, type RgbaImage } from './png.ts'
import { pngDimensions, preflightCaptureOutput, type CaptureResult } from './screenshot.ts'
import type { Session } from './types.ts'

const run = promisify(execFile)

/** One foreign toplevel the compositor announced. */
export interface Toplevel {
  /** Foreign-toplevel identifier; Hyprland reports the window's stable id in hex. */
  identifier: string
  /** Application id (the window class). */
  appId: string
  title: string
}

/** Options shared by the helper calls. */
export interface ToplevelOptions {
  /** Helper path; defaults to `bin/wl-capture` next to the project. */
  binary?: string
  /** Per-call timeout. */
  timeoutMs?: number
  /** Environment holding the session's XDG_RUNTIME_DIR. */
  env?: NodeJS.ProcessEnv
  /** Injectable clock for the capture timestamp. */
  now?: Date
}

/** Options for {@link captureToplevel}. */
export interface CaptureToplevelOptions extends ToplevelOptions {
  /** Destination PNG path. */
  output: string
  /** Foreign-toplevel identifier to capture. */
  identifier: string
}

/** Helper metadata line for a successful capture. */
interface HelperCapture {
  ok: true
  identifier: string
  appId: string
  title: string
  width: number
  height: number
  format: 'argb8888' | 'xrgb8888'
  transform: number
  bytes: number
}

/** Helper metadata line for a failure. */
interface HelperFailure {
  ok: false
  error?: string
}

/**
 * Default helper location inside the checkout.
 * @returns Absolute path to `bin/wl-capture`.
 */
export function defaultCaptureBinary(): string {
  return join(binDir(), 'wl-capture')
}

/**
 * Build the environment and arguments for one helper call.
 * @param session Discovered session.
 * @param env Base environment.
 * @param args Helper arguments.
 * @param binary Helper path.
 * @returns Spawn parameters.
 */
function helper(session: Session, env: NodeJS.ProcessEnv, args: string[], binary: string): {
  binary: string
  args: string[]
  env: NodeJS.ProcessEnv
} {
  if (session.waylandDisplay === null) {
    throw new HyprscopeError(ErrorCode.SCREENSHOT_FAILED, 'No Wayland display was discovered for this session', {
      runtimeDir: session.runtimeDir, hint: 'Pass --runtime-dir or set HYPRSCOPE_WAYLAND_DISPLAY',
    })
  }
  return {
    binary,
    args,
    env: { ...env, XDG_RUNTIME_DIR: session.runtimeDir, WAYLAND_DISPLAY: session.waylandDisplay },
  }
}

/**
 * Run the helper and parse its JSON line.
 * @param call Spawn parameters and timeout.
 * @returns Parsed helper output.
 */
async function callHelper(call: { binary: string; args: string[]; env: NodeJS.ProcessEnv }, timeoutMs: number): Promise<unknown> {
  try {
    const { stdout } = await run(call.binary, call.args, {
      env: call.env, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8',
    })
    const line = stdout.trim().split('\n').filter(entry => entry.trim() !== '').pop() ?? ''
    try {
      return JSON.parse(line) as unknown
    } catch {
      throw new HyprscopeError(ErrorCode.SCREENSHOT_FAILED, 'The capture helper returned malformed output', {
        sample: line.slice(0, 200),
      })
    }
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string; stdout?: string }
    if (failure instanceof HyprscopeError) throw failure
    if (failure.code === 'ENOENT') {
      throw new HyprscopeError(ErrorCode.SCREENSHOT_FAILED, 'The window capture helper is not built', {
        binary: call.binary, hint: 'Run `pnpm run build:capture` to build bin/wl-capture',
      })
    }
    if (failure.killed === true) {
      throw new HyprscopeError(ErrorCode.TIMEOUT, 'The window capture helper did not finish in time', { timeoutMs })
    }
    // The helper reports protocol failures as a JSON line on stdout.
    const raw = (failure.stdout ?? '').trim().split('\n').pop() ?? ''
    try {
      const parsed = JSON.parse(raw) as HelperFailure
      if (parsed.ok === false) {
        const reason = parsed.error ?? 'unknown'
        throw new HyprscopeError(ErrorCode.SCREENSHOT_FAILED, `The compositor could not capture this window: ${reason}`, {
          reason, stderr: (failure.stderr ?? '').trim().slice(0, 500),
        })
      }
    } catch (parseError) {
      if (parseError instanceof HyprscopeError) throw parseError
    }
    throw new HyprscopeError(ErrorCode.SCREENSHOT_FAILED, 'The window capture helper failed', {
      stderr: (failure.stderr ?? '').trim().slice(0, 500),
    })
  }
}

/**
 * List the foreign toplevels the compositor currently knows.
 * @param session Discovered session.
 * @param options Helper location, timeout, and environment.
 * @returns Toplevels in compositor order.
 */
export async function listToplevels(session: Session, options: ToplevelOptions = {}): Promise<Toplevel[]> {
  const env = options.env ?? process.env
  const timeoutMs = options.timeoutMs ?? 10_000
  const binary = options.binary ?? env.HYPRSCOPE_CAPTURE ?? defaultCaptureBinary()
  const call = helper(session, env, ['--list'], binary)
  const parsed = await callHelper(call, timeoutMs) as { ok?: boolean; toplevels?: unknown }
  if (parsed.ok !== true || !Array.isArray(parsed.toplevels)) {
    throw new HyprscopeError(ErrorCode.SCREENSHOT_FAILED, 'The capture helper did not return a toplevel list')
  }
  return parsed.toplevels.flatMap(entry => {
    if (entry === null || typeof entry !== 'object') return []
    const record = entry as Record<string, unknown>
    if (typeof record.identifier !== 'string' || record.identifier === '') return []
    return [{
      identifier: record.identifier,
      appId: typeof record.appId === 'string' ? record.appId : '',
      title: typeof record.title === 'string' ? record.title : '',
    }]
  })
}

/**
 * Rotate or flip raw pixels according to a wl_output_transform-style value.
 * A toplevel capture normally reports transform 0; the other values are handled
 * so a compositor that exports a rotated window still yields an upright PNG.
 * @param image Raw image.
 * @param transform Transform value 0..7.
 * @returns Oriented image.
 */
export function orientImage(image: RgbaImage, transform: number): RgbaImage {
  if (transform === 0) return image
  const { width, height, rgba } = image
  const flipped = transform >= 4
  const rotation = transform % 4
  let source = rgba
  let sourceWidth = width
  let sourceHeight = height
  if (flipped) {
    const copy = new Uint8Array(rgba.length)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const from = (y * width + x) * 4
        const to = (y * width + (width - 1 - x)) * 4
        copy[to] = rgba[from]!
        copy[to + 1] = rgba[from + 1]!
        copy[to + 2] = rgba[from + 2]!
        copy[to + 3] = rgba[from + 3]!
      }
    }
    source = copy
  }
  if (rotation === 0) return { width: sourceWidth, height: sourceHeight, rgba: source }
  const swaps = rotation === 1 || rotation === 3
  const outWidth = swaps ? sourceHeight : sourceWidth
  const outHeight = swaps ? sourceWidth : sourceHeight
  const out = new Uint8Array(source.length)
  for (let y = 0; y < sourceHeight; y++) {
    for (let x = 0; x < sourceWidth; x++) {
      let targetX: number
      let targetY: number
      if (rotation === 1) { targetX = y; targetY = sourceWidth - 1 - x }
      else if (rotation === 2) { targetX = sourceWidth - 1 - x; targetY = sourceHeight - 1 - y }
      else { targetX = sourceHeight - 1 - y; targetY = x }
      const from = (y * sourceWidth + x) * 4
      const to = (targetY * outWidth + targetX) * 4
      out[to] = source[from]!
      out[to + 1] = source[from + 1]!
      out[to + 2] = source[from + 2]!
      out[to + 3] = source[from + 3]!
    }
  }
  return { width: outWidth, height: outHeight, rgba: out }
}

/**
 * Capture one foreign toplevel to a PNG file.
 *
 * The destination directory must already exist and be writable: the same
 * `SCREENSHOT_FAILED` preflight as {@link capture} runs first, so an explicit
 * output is never silently created and the caller is told to pass a writable
 * `--output` path.
 * @param session Discovered session.
 * @param options Destination, identifier, and helper options.
 * @returns Capture metadata, with `source.scope` set to `window`.
 */
export async function captureToplevel(session: Session, options: CaptureToplevelOptions): Promise<CaptureResult> {
  const env = options.env ?? process.env
  const timeoutMs = options.timeoutMs ?? 10_000
  const binary = options.binary ?? env.HYPRSCOPE_CAPTURE ?? defaultCaptureBinary()
  if (!/^[A-Za-z0-9._:-]+$/.test(options.identifier)) {
    throw new HyprscopeError(ErrorCode.USAGE, 'Expected a foreign-toplevel identifier to capture')
  }
  const capturedAt = (options.now ?? new Date()).toISOString()
  const rawPath = `${options.output}.rgba`
  await preflightCaptureOutput(options.output)
  const call = helper(
    session, env,
    ['--capture', options.identifier, '--raw', rawPath, '--timeout-ms', String(timeoutMs)],
    binary,
  )
  try {
    const parsed = await callHelper(call, timeoutMs + 2_000) as HelperCapture
    if (parsed.ok !== true || !Number.isInteger(parsed.width) || !Number.isInteger(parsed.height)
      || parsed.width <= 0 || parsed.height <= 0) {
      throw new HyprscopeError(ErrorCode.SCREENSHOT_FAILED, 'The capture helper returned no image geometry')
    }
    const raw = await readFile(rawPath)
    if (raw.length !== parsed.width * parsed.height * 4) {
      throw new HyprscopeError(ErrorCode.SCREENSHOT_FAILED, 'The capture helper returned an unexpected image size', {
        expected: parsed.width * parsed.height * 4, bytes: raw.length,
      })
    }
    const image = orientImage({ width: parsed.width, height: parsed.height, rgba: raw }, parsed.transform)
    const png = encodePng(image)
    await writeFile(options.output, png)
    const dimensions = pngDimensions(png)
    return {
      path: options.output,
      bytes: png.length,
      width: dimensions.width,
      height: dimensions.height,
      sha256: createHash('sha256').update(png).digest('hex'),
      capturedAt,
      source: {
        monitor: null,
        region: null,
        scope: 'window',
        window: { identifier: parsed.identifier, appId: parsed.appId, title: parsed.title },
      },
    }
  } finally {
    await rm(rawPath, { force: true })
  }
}
