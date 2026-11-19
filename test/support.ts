/** Shared fixtures: temporary sessions, unix sockets, fake binaries, and PNG headers. */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Session } from '../src/types.ts'

/**
 * Create a disposable directory.
 * @param prefix Directory prefix.
 * @returns Absolute path.
 */
export function tempDir(prefix = 'hyprscope-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * Remove a disposable directory tree.
 * @param path Directory to delete.
 */
export function removeDir(path: string): void {
  // The overlay a test spawns can still be flushing a file when the test tears
  // the directory down; retrying ENOTEMPTY keeps that race out of the suite.
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
}

/**
 * Listen on a unix socket so `statSync().isSocket()` accepts the path.
 * @param path Socket path.
 * @returns Listening server.
 */
export async function listenUnix(path: string): Promise<Server> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => resolve())
  })
  return server
}

/**
 * Close a listening server.
 * @param server Server to close.
 * @returns Completion after the listener is gone.
 */
export function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => { server.close(() => resolve()) })
}

/**
 * Write an executable helper script.
 * @param directory Destination directory.
 * @param name File name.
 * @param body Script source including shebang.
 * @returns Absolute path.
 */
export function writeScript(directory: string, name: string, body: string): string {
  const path = join(directory, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}

/**
 * Build the bytes of a PNG header, enough for dimension parsing.
 * @param width Image width.
 * @param height Image height.
 * @returns Signature, IHDR length, type, dimensions, bit depth, and color type.
 */
export function makePng(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.writeUInt32BE(13, 8)
  buffer.write('IHDR', 12, 'latin1')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  buffer[24] = 8
  buffer[25] = 6
  return buffer
}

/** Options for {@link fakeInstance}. */
export interface FakeInstanceOptions {
  pid?: number
  display?: string | null
  logMtimeMs?: number
}

/** One fixture instance directory with its live sockets. */
export interface FakeInstance {
  dir: string
  servers: Server[]
}

/**
 * Create one Hyprland instance directory with live sockets and a lock file.
 * @param runtimeDir Runtime directory that should contain `hypr/`.
 * @param signature Instance signature.
 * @param options Lock contents and age.
 * @returns Created fixture.
 */
export async function fakeInstance(
  runtimeDir: string,
  signature: string,
  options: FakeInstanceOptions = {},
): Promise<FakeInstance> {
  const dir = join(runtimeDir, 'hypr', signature)
  mkdirSync(dir, { recursive: true })
  const servers = [
    await listenUnix(join(dir, '.socket.sock')),
    await listenUnix(join(dir, '.socket2.sock')),
  ]
  const pid = options.pid ?? 100
  const display = options.display === undefined ? 'wayland-1' : options.display
  writeFileSync(join(dir, 'hyprland.lock'), display === null ? `${pid}\n` : `${pid}\n${display}\n`)
  const log = join(dir, 'hyprland.log')
  writeFileSync(log, '')
  if (options.logMtimeMs !== undefined) utimesSync(log, options.logMtimeMs / 1000, options.logMtimeMs / 1000)
  return { dir, servers }
}

/**
 * Build a session record for pure unit tests.
 * @param overrides Fields to replace.
 * @returns Discovered-session-shaped record.
 */
export function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    runtimeDir: '/run/user/1000',
    signature: 'test-signature',
    instanceDir: '/run/user/1000/hypr/test-signature',
    pid: 100,
    waylandDisplay: 'wayland-1',
    waylandSocket: '/run/user/1000/wayland-1',
    controlSocket: '/run/user/1000/hypr/test-signature/.socket.sock',
    eventSocket: '/run/user/1000/hypr/test-signature/.socket2.sock',
    source: 'scan',
    instanceCount: 1,
    inherited: { waylandDisplay: false, signature: false },
    waylandDisplaySource: 'lock',
    ...overrides,
  }
}

/** Sink with accumulated text, for CLI tests. */
export interface Sink {
  write(chunk: string): boolean
  readonly text: string
}

/**
 * Collect written output for CLI tests.
 * @returns Sink with accumulated text.
 */
export function sink(): Sink {
  let data = ''
  return {
    write(chunk: string): boolean { data += chunk; return true },
    get text(): string { return data },
  }
}
