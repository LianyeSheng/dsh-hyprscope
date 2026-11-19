/** Desktop-message state files shared by the CLI, the overlay and the DSH plugin. */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { ErrorCode, HyprscopeError } from '../errors.ts'

/** Key combination the desktop-message shortcut uses when nothing else is recorded. */
export const DEFAULT_MESSAGE_KEY = 'SUPER + ALT + M'

/** Version of the state-file contract. */
export const MESSAGE_STATE_VERSION = 1

/** A status file older than this is not a live Host. */
export const STATUS_FRESH_MS = 20_000

/** Every path one desktop-message session uses. */
export interface MessagePaths {
  /** Directory that holds all files below. */
  dir: string
  /** Host liveness, configuration and target written by the DSH plugin. */
  statusFile: string
  /** Composer-open request written by `hyprscope message open`. */
  openFile: string
  /** Injection receipt written by the DSH plugin. */
  ackFile: string
  /** Overlay-exit request written by `hyprscope message stop`. */
  quitFile: string
  /** Normalized shortcut key written by `hyprscope control install-bind`. */
  shortcutFile: string
  /** Directory the overlay writes composed messages into. */
  outboxDir: string
  /** Most recently active root Session, so a desktop message survives a Host restart. */
  lastSessionFile: string
  /** Quickshell log for the desktop-message overlay. */
  overlayLog: string
}

/** Host status record the plugin refreshes while DSH runs. */
export interface MessageStatus {
  version: number
  alive: boolean
  pid: number | null
  updatedAt: string
  language: 'zh' | 'en'
  attachScreenshot: boolean
  sessionId: string | null
  error: string | null
}

/** One composer request; the nonce distinguishes two requests. */
export interface OpenRequest {
  nonce: string
  at: string
}

/** One message composed by the overlay. */
export interface OutgoingMessage {
  id: string
  text: string
  at: string
}

/** One injection receipt shown back to the overlay. */
export interface MessageAck {
  id: string
  ok: boolean
  message: string | null
  sessionId: string | null
  at: string
}

/**
 * Resolve the desktop-message directory.
 *
 * `HYPRSCOPE_MESSAGE_DIR` is the test and plugin override; the plugin sets it
 * when it spawns the CLI, so both sides always agree. The default sits next to
 * the lease and baseline state.
 * @param env Environment to read.
 * @returns Absolute directory path.
 */
export function messageDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (typeof env.HYPRSCOPE_MESSAGE_DIR === 'string' && env.HYPRSCOPE_MESSAGE_DIR.trim() !== '') {
    return resolve(env.HYPRSCOPE_MESSAGE_DIR)
  }
  const base = env.XDG_STATE_HOME !== undefined && env.XDG_STATE_HOME !== ''
    ? env.XDG_STATE_HOME
    : join(env.HOME ?? homedir(), '.local', 'state')
  return join(base, 'hyprscope', 'message')
}

/**
 * @param dir Message directory.
 * @returns Every path the desktop-message flow uses inside it.
 */
export function messagePaths(dir: string = messageDirectory()): MessagePaths {
  return {
    dir,
    statusFile: join(dir, 'status.json'),
    openFile: join(dir, 'open.json'),
    ackFile: join(dir, 'ack.json'),
    quitFile: join(dir, 'quit.json'),
    shortcutFile: join(dir, 'shortcut.txt'),
    outboxDir: join(dir, 'outbox'),
    lastSessionFile: join(dir, 'last-session.json'),
    overlayLog: join(dir, 'overlay.log'),
  }
}

/**
 * Create the message directory (and the outbox) when missing, owner-only.
 * @param paths Message paths.
 */
export async function ensureMessageDirectory(paths: MessagePaths): Promise<void> {
  try {
    await mkdir(paths.outboxDir, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new HyprscopeError(ErrorCode.COMMAND_FAILED, `Cannot create the desktop-message directory ${paths.dir}`, {
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Write one JSON document atomically: a sibling temp file plus rename, so a
 * reader never observes a partial document.
 * @param path Destination path.
 * @param value JSON-compatible value.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Read one JSON document, treating a missing or malformed file as absent.
 * @param path Source path.
 * @returns Parsed value, or null.
 */
export async function readJson(path: string): Promise<unknown> {
  try {
    const text = await readFile(path, 'utf8')
    const parsed: unknown = JSON.parse(text)
    return parsed ?? null
  } catch {
    return null
  }
}

/** @param value Candidate record. @returns Whether it has the fields the overlay reads. */
function isStatus(value: unknown): value is MessageStatus {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.version === MESSAGE_STATE_VERSION
    && typeof record.alive === 'boolean'
    && typeof record.updatedAt === 'string'
    && (record.language === 'zh' || record.language === 'en')
    && typeof record.attachScreenshot === 'boolean'
}

/**
 * Read the Host status written by the DSH plugin.
 * @param paths Message paths.
 * @returns Valid status record, or null.
 */
export async function readStatus(paths: MessagePaths): Promise<MessageStatus | null> {
  const value = await readJson(paths.statusFile)
  return isStatus(value) ? value : null
}

/**
 * Whether a status record still describes a running Host.
 * @param status Status record.
 * @param now Current epoch milliseconds.
 * @returns Whether the heartbeat is inside the freshness window.
 */
export function statusFresh(status: MessageStatus, now: number = Date.now()): boolean {
  const updated = Date.parse(status.updatedAt)
  return Number.isFinite(updated) && now - updated <= STATUS_FRESH_MS
}

/** @returns A fresh composer nonce. */
function newNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Ask the overlay to open the composer.
 * @param paths Message paths; the directory must exist.
 * @returns The request that was written.
 */
export async function writeOpenRequest(paths: MessagePaths): Promise<OpenRequest> {
  const request: OpenRequest = { nonce: newNonce(), at: new Date().toISOString() }
  await writeJsonAtomic(paths.openFile, request)
  return request
}

/**
 * Ask a running overlay to exit.
 * @param paths Message paths; the directory must exist.
 */
export async function writeQuitRequest(paths: MessagePaths): Promise<void> {
  await writeJsonAtomic(paths.quitFile, { at: new Date().toISOString() })
}

/**
 * Read the shortcut key recorded by `install-bind`.
 * @param paths Message paths.
 * @returns Normalized key combination; the default when none is recorded.
 */
export async function readShortcutKey(paths: MessagePaths): Promise<string> {
  try {
    const text = (await readFile(paths.shortcutFile, 'utf8')).trim()
    return text === '' ? DEFAULT_MESSAGE_KEY : text
  } catch {
    return DEFAULT_MESSAGE_KEY
  }
}
