/** Install the Hyprland failsafe shortcut that revokes a lease. */
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import { hyprctlJson } from '../hyprctl.ts'
import { messageDirectory, messagePaths } from '../message/state.ts'
import { discoverSession } from '../session.ts'
import type { Session } from '../types.ts'
import { hyprscopeBin } from './overlay.ts'

const run = promisify(execFile)

/** Key combination bound to the failsafe release. */
export const DEFAULT_PANIC_KEY = 'SUPER + ALT + ESC'

/** Key combination bound to the desktop-message composer. */
export const DEFAULT_MESSAGE_KEY = 'SUPER + ALT + M'
const MARKER_BEGIN = '-- >>> hyprscope failsafe >>>'
const MARKER_END = '-- <<< hyprscope failsafe <<<'
/** Marker written before the CLI was unified; still removable and replaceable. */
const LEGACY_MARKER_BEGIN = '-- >>> hyprlease failsafe >>>'
const LEGACY_MARKER_END = '-- <<< hyprlease failsafe <<<'

/** Modifier bit values used by Hyprland binds. */
const MODIFIERS: Record<string, number> = { SHIFT: 1, CAPS: 2, CTRL: 4, ALT: 8, MOD2: 16, MOD3: 32, SUPER: 64, MOD5: 128 }

/** Spellings Hyprland reports differently from the common shorthand. */
const XKB_NAMES: Record<string, string> = { ESC: 'Escape', ESCAPE: 'Escape' }

/** One bind entry from `hyprctl binds -j`. */
export interface BindRecord {
  modmask?: number
  key?: string
  arg?: string
  description?: string
  has_description?: boolean
  dispatcher?: string
}

/** Description attached to the failsafe bind so it can be verified later. */
export const BIND_DESCRIPTION = 'hyprscope failsafe: revoke desktop control'

/** Description attached to the desktop-message bind so it can be verified later. */
export const MESSAGE_BIND_DESCRIPTION = 'hyprscope message: open the desktop composer'

/** Result of installing the managed binds. */
export interface BindInstallResult {
  key: string
  command: string
  messageKey: string
  messageCommand: string
  luaFile: string
  configFile: string
  backupFile: string | null
  verified: boolean
  messageVerified: boolean
  shortcutFile: string
}

/** Options for {@link installBind}. */
export interface BindOptions {
  key?: string
  messageKey?: string
  env?: NodeJS.ProcessEnv
  session?: Session
  now?: Date
}

/**
 * Quote one shell word.
 * @param value Raw argument.
 * @returns Single-quoted shell word.
 */
export function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Build the command the panic shortcut runs.
 * @param env Environment that selects the Node binary and entry point.
 * @returns Shell command string for `hl.dsp.exec_cmd`.
 */
export function panicCommand(env: NodeJS.ProcessEnv = process.env): string {
  return [env.HYPRSCOPE_NODE ?? process.execPath, hyprscopeBin(), 'control', 'panic', '--source', 'shortcut']
    .map(quoteShell).join(' ')
}

/**
 * Build the command the desktop-message shortcut runs.
 * @param env Environment that selects the Node binary and entry point.
 * @returns Shell command string for `hl.dsp.exec_cmd`.
 */
export function messageCommand(env: NodeJS.ProcessEnv = process.env): string {
  return [env.HYPRSCOPE_NODE ?? process.execPath, hyprscopeBin(), 'message', 'open']
    .map(quoteShell).join(' ')
}

/**
 * Build the Lua file that registers the managed binds.
 * @param key Failsafe key combination.
 * @param command Command run on the failsafe shortcut.
 * @param messageKey Desktop-message key combination.
 * @param messageCommandValue Command run on the message shortcut.
 * @returns Lua source.
 */
export function luaSource(
  key: string,
  command: string,
  messageKey: string = DEFAULT_MESSAGE_KEY,
  messageCommandValue: string = messageCommand(),
): string {
  return [
    `${MARKER_BEGIN}`,
    '-- Managed by `hyprscope control install-bind`; rerun the command instead of editing this file.',
    `hl.bind("${key}", hl.dsp.exec_cmd(${JSON.stringify(command)}), { description = ${JSON.stringify(BIND_DESCRIPTION)} })`,
    `hl.bind("${messageKey}", hl.dsp.exec_cmd(${JSON.stringify(messageCommandValue)}), { description = ${JSON.stringify(MESSAGE_BIND_DESCRIPTION)} })`,
    `${MARKER_END}`,
    '',
  ].join('\n')
}

/**
 * Rewrite a key combination with the spelling Hyprland reports.
 * @param key Key combination such as `SUPER + ALT + ESC`.
 * @returns Combination using the normalized key name.
 */
export function normalizedKey(key: string): string {
  const { name } = parseKey(key)
  return key.split('+').map(part => part.trim()).filter(part => part !== '')
    .map(part => MODIFIERS[part.toUpperCase()] !== undefined ? part.toUpperCase() : name)
    .join(' + ')
}

/**
 * Build the block appended to the user's `hyprland.lua`.
 * The binds are inline because a `dofile`/`require` indirection is not executed
 * reliably by the Lua config provider on reload.
 * @param key Failsafe key combination.
 * @param command Command run on the failsafe shortcut.
 * @param messageKey Desktop-message key combination.
 * @param messageCommandValue Command run on the message shortcut.
 * @returns Lua source block.
 */
export function configBlock(
  key: string,
  command: string,
  messageKey: string = DEFAULT_MESSAGE_KEY,
  messageCommandValue: string = messageCommand(),
): string {
  return [
    '',
    `${MARKER_BEGIN}`,
    '-- Failsafe control release and desktop-message composer for `hyprscope` (managed; remove with `hyprscope control uninstall-bind`).',
    `hl.bind("${normalizedKey(key)}", hl.dsp.exec_cmd(${JSON.stringify(command)}), { description = ${JSON.stringify(BIND_DESCRIPTION)} })`,
    `hl.bind("${normalizedKey(messageKey)}", hl.dsp.exec_cmd(${JSON.stringify(messageCommandValue)}), { description = ${JSON.stringify(MESSAGE_BIND_DESCRIPTION)} })`,
    `${MARKER_END}`,
    '',
  ].join('\n')
}

/**
 * @param env Environment to read.
 * @returns Hyprland configuration directory.
 */
export function hyprConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HYPR_CONFIG_DIR ?? join(homedir(), '.config', 'hypr')
}

/**
 * @param key Key combination such as `SUPER + ALT + ESC`.
 * @returns Modifier mask and normalized key name.
 */
export function parseKey(key: string): { modmask: number; name: string } {
  const parts = key.split('+').map(part => part.trim().toUpperCase()).filter(part => part !== '')
  if (parts.length === 0) throw new HyprscopeError(ErrorCode.USAGE, `Expected a key combination, received ${key}`)
  let modmask = 0
  let name = ''
  for (const part of parts) {
    const bit = MODIFIERS[part]
    if (bit !== undefined) modmask |= bit
    else name = part
  }
  if (name === '') throw new HyprscopeError(ErrorCode.USAGE, `Key combination ${key} has no non-modifier key`)
  return { modmask, name: XKB_NAMES[name] ?? name }
}

/**
 * @param binds Current binds.
 * @param key Key combination to test.
 * @returns Whether another bind already owns the combination.
 */
export function keyTaken(binds: BindRecord[], key: string): boolean {
  const { modmask, name } = parseKey(key)
  return binds.some(bind => (bind.modmask ?? 0) === modmask && (bind.key ?? '') === name)
}

/**
 * Run the one mutating hyprctl command this project allows: reloading user configuration.
 * @param session Discovered session.
 * @param env Environment for the child.
 */
async function reloadConfig(session: Session, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await run('hyprctl', ['reload'], {
      env: { ...env, XDG_RUNTIME_DIR: session.runtimeDir, HYPRLAND_INSTANCE_SIGNATURE: session.signature },
      timeout: 5000, encoding: 'utf8',
    })
  } catch (error) {
    throw new HyprscopeError(ErrorCode.BIND_FAILED, 'hyprctl reload failed', {
      stderr: (error as { stderr?: string }).stderr?.trim() ?? '',
    })
  }
}

/** One managed failsafe block in the configuration. */
interface ConfigBlockRange {
  begin: number
  end: number
}

/**
 * Locate a managed failsafe block, including the marker written before the CLI
 * was unified.
 * @param text Configuration text.
 * @param configFile Path named in the failure.
 * @returns Offsets, or null when no block exists.
 */
function findBlock(text: string, configFile: string): ConfigBlockRange | null {
  for (const [beginMarker, endMarker] of [
    [MARKER_BEGIN, MARKER_END],
    [LEGACY_MARKER_BEGIN, LEGACY_MARKER_END],
  ] as const) {
    const begin = text.indexOf(beginMarker)
    if (begin < 0) continue
    const endAt = text.indexOf(endMarker, begin)
    if (endAt < 0) {
      throw new HyprscopeError(ErrorCode.BIND_FAILED, 'The hyprscope failsafe block is missing its end marker', { configFile })
    }
    return { begin, end: endAt + endMarker.length }
  }
  return null
}

/** @param bind One hyprctl bind record. @returns Whether the managed block owns it. */
function managedBind(bind: BindRecord): boolean {
  const description = bind.description ?? ''
  return description.includes(BIND_DESCRIPTION) || description.includes(MESSAGE_BIND_DESCRIPTION)
}

/**
 * Record the desktop-message shortcut where the overlay reads it.
 * @param env Environment that resolves the message directory.
 * @param key Normalized key combination.
 * @param messageDir Optional resolved directory (tests).
 * @returns Absolute shortcut file path.
 */
async function recordShortcut(env: NodeJS.ProcessEnv, key: string, messageDir?: string): Promise<string> {
  const paths = messagePaths(messageDir ?? messageDirectory(env))
  await mkdir(paths.dir, { recursive: true, mode: 0o700 })
  await writeFile(paths.shortcutFile, `${key}\n`, { mode: 0o644 })
  return paths.shortcutFile
}

/**
 * Install the managed binds (failsafe release and desktop-message composer)
 * into the user's Hyprland configuration.
 * @param options Keys, environment, and an optional discovered session.
 * @returns Install result including whether both binds were observed afterwards.
 */
export async function installBind(options: BindOptions = {}): Promise<BindInstallResult> {
  const env = options.env ?? process.env
  const session = options.session ?? discoverSession({ env })
  const key = options.key ?? DEFAULT_PANIC_KEY
  const messageKey = options.messageKey ?? DEFAULT_MESSAGE_KEY
  if (normalizedKey(key) === normalizedKey(messageKey)) {
    throw new HyprscopeError(ErrorCode.BIND_FAILED, 'The failsafe and desktop-message shortcuts must differ', {
      key, messageKey,
    })
  }
  const configDir = hyprConfigDir(env)
  const configFile = join(configDir, 'hyprland.lua')
  const luaFile = join(configDir, 'hyprscope.lua')
  const command = panicCommand(env)
  const messageCmd = messageCommand(env)
  let configText: string
  try {
    configText = await readFile(configFile, 'utf8')
  } catch {
    throw new HyprscopeError(ErrorCode.BIND_FAILED, `No Hyprland Lua config at ${configFile}`, { configFile })
  }
  const binds = (await hyprctlJson<BindRecord[]>(session, 'binds')) ?? []
  // Reinstalling replaces the managed block, so its own binds are not conflicts.
  const foreign = binds.filter(bind => !managedBind(bind))
  if (keyTaken(foreign, key)) {
    throw new HyprscopeError(ErrorCode.BIND_FAILED, `Key ${key} is already bound`, { key })
  }
  if (keyTaken(foreign, messageKey)) {
    throw new HyprscopeError(ErrorCode.BIND_FAILED, `Key ${messageKey} is already bound`, { messageKey })
  }
  await writeFile(luaFile, luaSource(normalizedKey(key), command, normalizedKey(messageKey), messageCmd), { mode: 0o644 })
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const backupFile = `${configFile}.bak-hyprscope-${stamp}`
  await copyFile(configFile, backupFile)
  const block = findBlock(configText, configFile)
  const nextBlock = configBlock(key, command, messageKey, messageCmd)
  if (block === null) {
    await writeFile(configFile, `${configText}${nextBlock}`)
  } else {
    await writeFile(configFile, `${configText.slice(0, block.begin)}${nextBlock.trim()}${configText.slice(block.end)}`)
  }
  await reloadConfig(session, env)
  const errors = (await hyprctlJson<string[]>(session, 'configerrors')) ?? []
  const relevant = errors.filter(error => typeof error === 'string'
    && (error.includes('hyprscope') || error.includes('hyprlease')))
  if (relevant.length > 0) {
    await writeFile(configFile, configText)
    await removeLua(luaFile)
    await reloadConfig(session, env)
    throw new HyprscopeError(ErrorCode.BIND_FAILED, 'The managed binds broke the Hyprland configuration; restored the backup', {
      errors: relevant,
    })
  }
  const after = (await hyprctlJson<BindRecord[]>(session, 'binds')) ?? []
  const verified = after.some(bind => (bind.description ?? '').includes(BIND_DESCRIPTION))
  const messageVerified = after.some(bind => (bind.description ?? '').includes(MESSAGE_BIND_DESCRIPTION))
  if (!verified || !messageVerified) {
    await writeFile(configFile, configText)
    await removeLua(luaFile)
    await reloadConfig(session, env)
    throw new HyprscopeError(ErrorCode.BIND_FAILED, 'The managed binds did not all appear in hyprctl binds; restored the backup', {
      key, messageKey, configFile, verified, messageVerified,
    })
  }
  let shortcutFile: string
  try {
    shortcutFile = await recordShortcut(env, normalizedKey(messageKey))
  } catch (error) {
    await writeFile(configFile, configText)
    await removeLua(luaFile)
    await reloadConfig(session, env)
    throw new HyprscopeError(ErrorCode.BIND_FAILED, 'The binds were installed but the message shortcut could not be recorded; restored the backup', {
      configFile,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
  return {
    key: normalizedKey(key),
    command,
    messageKey: normalizedKey(messageKey),
    messageCommand: messageCmd,
    luaFile,
    configFile,
    backupFile,
    verified,
    messageVerified,
    shortcutFile,
  }
}

/**
 * Remove the managed binds, the desktop-message shortcut record and the
 * generated Lua file.
 * @param options Environment and an optional discovered session.
 * @returns Whether a block was removed.
 */
export async function uninstallBind(options: {
  env?: NodeJS.ProcessEnv
  session?: Session
} = {}): Promise<{ removed: boolean; backupFile: string | null }> {
  const env = options.env ?? process.env
  const session = options.session ?? discoverSession({ env })
  const configDir = hyprConfigDir(env)
  const configFile = join(configDir, 'hyprland.lua')
  const luaFile = join(configDir, 'hyprscope.lua')
  const text = await readFile(configFile, 'utf8')
  const block = findBlock(text, configFile)
  if (block === null) return { removed: false, backupFile: null }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupFile = `${configFile}.bak-hyprscope-${stamp}`
  await copyFile(configFile, backupFile)
  const next = `${text.slice(0, block.begin)}${text.slice(block.end)}`.replace(/\n{3,}/g, '\n\n')
  await writeFile(configFile, next)
  await removeLua(luaFile)
  await removeLua(join(configDir, 'hyprlease.lua'))
  await removeLua(messagePaths(messageDirectory(env)).shortcutFile)
  await reloadConfig(session, env)
  return { removed: true, backupFile }
}

/**
 * Delete the generated Lua file.
 * @param path File path.
 */
async function removeLua(path: string): Promise<void> {
  try {
    const { unlink } = await import('node:fs/promises')
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
