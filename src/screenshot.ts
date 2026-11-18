/** PNG capture through grim, with geometry validation and image metadata. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, constants, mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { ErrorCode, HyprscopeError } from './errors.ts'
import type { Session } from './types.ts'

const run = promisify(execFile)
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** IHDR fields read from a PNG header. */
export interface PngDimensions {
  width: number
  height: number
  bitDepth: number
  colorType: number
}

/** Capture region in global layout coordinates. */
export interface Region {
  x: number
  y: number
  width: number
  height: number
}

/** Capture source and destination options. */
export interface CaptureOptions {
  output?: string
  monitor?: string
  region?: Region
  timeoutMs?: number
  binary?: string
  now?: Date
  env?: NodeJS.ProcessEnv
}

/** One window a capture was taken from, when the source was a foreign toplevel. */
export interface WindowCaptureSource {
  /** Foreign-toplevel identifier the compositor reported. */
  identifier: string
  /** Application id (the window class). */
  appId: string
  title: string
}

/** Result of one capture. */
export interface CaptureResult {
  path: string
  bytes: number
  width: number
  height: number
  sha256: string
  capturedAt: string
  source: {
    monitor: string | null
    region: Region | null
    scope: 'region' | 'monitor' | 'layout' | 'window'
    /** Present only for `scope: 'window'` captures. */
    window: WindowCaptureSource | null
  }
}

/**
 * Read dimensions from a PNG header.
 * @param buffer Complete PNG bytes.
 * @returns IHDR fields.
 */
export function pngDimensions(buffer: Buffer): PngDimensions {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new HyprscopeError(ErrorCode.SCREENSHOT_FAILED, 'Capture did not produce a PNG image')
  }
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') {
    throw new HyprscopeError(ErrorCode.SCREENSHOT_FAILED, 'PNG is missing its IHDR chunk')
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer.readUInt8(24),
    colorType: buffer.readUInt8(25),
  }
}

/**
 * Resolve the directory that receives captures.
 * @param env Environment to read.
 * @returns Absolute cache directory.
 */
export function captureDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME ?? join(homedir(), '.cache')
  return join(base, 'hyprscope')
}

/**
 * Default destination for a capture that was not given an output path.
 * @param env Environment to read.
 * @param now Capture time.
 * @returns Absolute PNG path under the cache directory.
 */
export function defaultCapturePath(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): string {
  return join(captureDirectory(env), `screenshot-${now.toISOString().replace(/[:.]/g, '-')}.png`)
}

/**
 * Build the typed failure for an unusable capture destination.
 * @param directory Destination directory.
 * @param path Destination PNG path.
 * @param reason Why the directory cannot receive the capture.
 * @returns `SCREENSHOT_FAILED` naming the fix.
 */
function outputFailure(directory: string, path: string, reason: string): HyprscopeError {
  return new HyprscopeError(ErrorCode.SCREENSHOT_FAILED,
    `Cannot write the capture: ${reason}; pass --output <writable path>`, {
      directory,
      output: path,
      hint: 'Pass --output <path> inside an existing, writable directory',
    })
}

/**
 * Preflight the directory that receives a capture.
 *
 * An explicit `--output` must point into a directory that already exists and is
 * writable; the default cache directory is created first. The check leaves
 * nothing behind: it uses stat and access only, never a probe file.
 * @param path Destination PNG path.
 * @param options `create` creates the default cache directory, never an explicit one.
 * @throws HyprscopeError when the directory is missing, not a directory, or not writable.
 */
export async function preflightCaptureOutput(path: string, options: { create?: boolean } = {}): Promise<void> {
  const directory = dirname(path)
  if (options.create === true) {
    try {
      await mkdir(directory, { recursive: true })
    } catch (error) {
      throw outputFailure(directory, path,
        `the capture directory could not be created (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  const status = await stat(directory).catch(() => null)
  if (status === null || !status.isDirectory()) {
    throw outputFailure(directory, path, 'the capture directory does not exist')
  }
  try {
    await access(directory, constants.W_OK)
  } catch (error) {
    throw outputFailure(directory, path,
      `the capture directory is not writable (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * Validate and normalize a `x,y,width,height` region.
 * @param text Region in global layout coordinates.
 * @returns Parsed region.
 */
export function parseRegion(text: string): Region {
  const parts = text.split(',').map(part => Number.parseInt(part.trim(), 10))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) {
    throw new HyprscopeError(ErrorCode.USAGE, `Expected --region x,y,width,height, received ${text}`)
  }
  const x = parts[0]!
  const y = parts[1]!
  const width = parts[2]!
  const height = parts[3]!
  if (width <= 0 || height <= 0) {
    throw new HyprscopeError(ErrorCode.USAGE, 'Region width and height must be positive', { region: text })
  }
  return { x, y, width, height }
}

/**
 * Capture a PNG of the whole layout, one monitor, or one region.
 * @param session Discovered session.
 * @param options Destination, capture source, limits, and injectable clock/environment.
 * @returns Captured file metadata.
 */
export async function capture(session: Session, options: CaptureOptions = {}): Promise<CaptureResult> {
  const env = options.env ?? process.env
  if (options.monitor !== undefined && options.region !== undefined) {
    throw new HyprscopeError(ErrorCode.USAGE, 'Choose either --monitor or --region, not both')
  }
  if (options.monitor !== undefined && options.monitor.trim() === '') {
    throw new HyprscopeError(ErrorCode.USAGE, 'Expected a monitor name after --monitor')
  }
  if (session.waylandDisplay === null) {
    throw new HyprscopeError(ErrorCode.SCREENSHOT_FAILED, 'No Wayland display was discovered for this session', {
      runtimeDir: session.runtimeDir, hint: 'Pass --runtime-dir or set HYPRSCOPE_WAYLAND_DISPLAY',
    })
  }
  const capturedAt = (options.now ?? new Date()).toISOString()
  const path = options.output ?? defaultCapturePath(env, options.now ?? new Date())
  await preflightCaptureOutput(path, { create: options.output === undefined })
  const args: string[] = []
  if (options.monitor !== undefined) args.push('-o', options.monitor)
  if (options.region !== undefined) {
    const { x, y, width, height } = options.region
    args.push('-g', `${x},${y} ${width}x${height}`)
  }
  args.push(path)
  const binary = options.binary ?? env.HYPRSCOPE_GRIM ?? 'grim'
  try {
    await run(binary, args, {
      env: { ...env, XDG_RUNTIME_DIR: session.runtimeDir, WAYLAND_DISPLAY: session.waylandDisplay },
      timeout: options.timeoutMs ?? 10000, maxBuffer: 1024 * 1024, encoding: 'utf8',
    })
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string }
    if (failure.code === 'ENOENT') {
      throw new HyprscopeError(ErrorCode.SCREENSHOT_FAILED, 'grim is not installed or not on PATH')
    }
    if (failure.killed === true) {
      throw new HyprscopeError(ErrorCode.TIMEOUT, 'grim did not finish in time', { timeoutMs: options.timeoutMs ?? 10000 })
    }
    throw new HyprscopeError(ErrorCode.SCREENSHOT_FAILED, 'grim failed to capture the frame', {
      stderr: typeof failure.stderr === 'string' ? failure.stderr.trim() : '',
    })
  }
  const bytes = await readFile(path)
  const { width, height } = pngDimensions(bytes)
  return {
    path,
    bytes: bytes.length,
    width,
    height,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    capturedAt,
    source: {
      monitor: options.monitor ?? null,
      region: options.region ?? null,
      scope: options.region !== undefined ? 'region' : options.monitor !== undefined ? 'monitor' : 'layout',
      window: null,
    },
  }
}
