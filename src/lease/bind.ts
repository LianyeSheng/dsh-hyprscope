/** Install the managed Hyprland shortcuts: failsafe release, desktop composer, desktop annotator. */
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
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

/** Key combination bound to the desktop annotator. */
export const DEFAULT_ANNOTATE_KEY = 'SUPER + ALT + A'
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

/** Description attached to the desktop-annotate bind so it can be verified later. */
export const ANNOTATE_BIND_DESCRIPTION = 'hyprscope: desktop annotate'

/** Shortcut record the overlay reads to show the desktop-annotate combination. */
export const ANNOTATE_SHORTCUT_FILE = 'annotate-shortcut.txt'

/** Result of installing the managed binds. */
export interface BindInstallResult {
  key: string
  command: string
  messageKey: string
  messageCommand: string
  annotateKey: string
  annotateCommand: string
  luaFile: string
  configFile: string
  backupFile: string | null
  verified: boolean
  messageVerified: boolean
  annotateVerified: boolean
  shortcutFile: string
  annotateShortcutFile: string
}

/** Options for {@link installBind}. */
export interface BindOptions {
  key?: string
  messageKey?: string
  annotateKey?: string
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
 * Build the command the desktop-annotate shortcut runs.
 * @param env Environment that selects the Node binary and entry point.
 * @returns Shell command string for `hl.dsp.exec_cmd`.
 */
export function annotateCommand(env: NodeJS.ProcessEnv = process.env): string {
  return [env.HYPRSCOPE_NODE ?? process.execPath, hyprscopeBin(), 'message', 'annotate']
    .map(quoteShell).join(' ')
}

/**
 * Build the Lua file that registers the managed binds.
 * @param key Failsafe key combination.
 * @param command Command run on the failsafe shortcut.
 * @param messageKey Desktop-message key combination.
 * @param messageCommandValue Command run on the message shortcut.
 * @param annotateKey Desktop-annotate key combination.
 * @param annotateCommandValue Command run on the annotate shortcut.
 * @returns Lua source.
 */
export function luaSource(
  key: string,
  command: string,
  messageKey: string = DEFAULT_MESSAGE_KEY,
  messageCommandValue: string = messageCommand(),
  annotateKey: string = DEFAULT_ANNOTATE_KEY,
  annotateCommandValue: string = annotateCommand(),
): string {
  return [
    `${MARKER_BEGIN}`,
    '-- Managed by `hyprscope control install-bind`; rerun the command instead of editing this file.',
    `hl.bind("${key}", hl.dsp.exec_cmd(${JSON.stringify(command)}), { description = ${JSON.stringify(BIND_DESCRIPTION)} })`,
    `hl.bind("${messageKey}", hl.dsp.exec_cmd(${JSON.stringify(messageCommandValue)}), { description = ${JSON.stringify(MESSAGE_BIND_DESCRIPTION)} })`,
    `hl.bind("${annotateKey}", hl.dsp.exec_cmd(${JSON.stringify(annotateCommandValue)}), { description = ${JSON.stringify(ANNOTATE_BIND_DESCRIPTION)} })`,
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
 * @param annotateKey Desktop-annotate key combination.
 * @param annotateCommandValue Command run on the annotate shortcut.
 * @returns Lua source block.
 */
export function configBlock(
  key: string,
  command: string,
  messageKey: string = DEFAULT_MESSAGE_KEY,
  messageCommandValue: string = messageCommand(),
  annotateKey: string = DEFAULT_ANNOTATE_KEY,
  annotateCommandValue: string = annotateCommand(),
): string {
  return [
    '',
    `${MARKER_BEGIN}`,
    '-- Failsafe control release, desktop-message composer and desktop annotator for `hyprscope` (managed; remove with `hyprscope control uninstall-bind`).',
    `hl.bind("${normalizedKey(key)}", hl.dsp.exec_cmd(${JSON.stringify(command)}), { description = ${JSON.stringify(BIND_DESCRIPTION)} })`,
    `hl.bind("${normalizedKey(messageKey)}", hl.dsp.exec_cmd(${JSON.stringify(messageCommandValue)}), { description = ${JSON.stringify(MESSAGE_BIND_DESCRIPTION)} })`,
    `hl.bind("${normalizedKey(annotateKey)}", hl.dsp.exec_cmd(${JSON.stringify(annotateCommandValue)}), { description = ${JSON.stringify(ANNOTATE_BIND_DESCRIPTION)} })`,
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
  return description.includes(BIND_DESCRIPTION)
    || description.includes(MESSAGE_BIND_DESCRIPTION)
    || description.includes(ANNOTATE_BIND_DESCRIPTION)
}

/**
 * @param env Environment that resolves the message directory.
 * @returns Absolute path of the desktop-annotate shortcut record beside `shortcut.txt`.
 */
export function annotateShortcutPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(messagePaths(messageDirectory(env)).dir, ANNOTATE_SHORTCUT_FILE)
}

/**
 * Read a shortcut record so a failed install can put it back.
 * @param file Shortcut file path.
 * @returns Previous text, or null when the file did not exist.
 */
async function readShortcut(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Record one shortcut combination where the overlay reads it.
 * @param file Shortcut file path.
 * @param key Normalized key combination.
 */
async function writeShortcut(file: string, key: string): Promise<void> {
  await writeFile(file, `${key}\n`, { mode: 0o644 })
}

/**
 * Put one shortcut record back exactly as it was before an install.
 * @param file Shortcut file path.
 * @param previous Text read before the install, or null when it did not exist.
 */
async function restoreShortcut(file: string, previous: string | null): Promise<void> {
  if (previous === null) {
    await removeFile(file)
    return
  }
  await writeFile(file, previous, { mode: 0o644 })
}

/**
 * Install the managed binds (failsafe release, desktop-message composer and
 * desktop annotator) into the user's Hyprland configuration.
 * @param options Keys, environment, and an optional discovered session.
 * @returns Install result including whether all three binds were observed afterwards.
 */
export async function installBind(options: BindOptions = {}): Promise<BindInstallResult> {
  const env = options.env ?? process.env
  const session = options.session ?? discoverSession({ env })
  const key = options.key ?? DEFAULT_PANIC_KEY
  const messageKey = options.messageKey ?? DEFAULT_MESSAGE_KEY
  const annotateKey = options.annotateKey ?? DEFAULT_ANNOTATE_KEY
  const combinations = [key, messageKey, annotateKey].map(normalizedKey)
  const duplicated = [...new Set(combinations.filter((combination, index) => combinations.indexOf(combination) !== index))]
  if (duplicated.length > 0) {
    throw new HyprscopeError(ErrorCode.BIND_FAILED,
      'The failsafe, desktop-message and desktop-annotate shortcuts must differ', {
        key, messageKey, annotateKey, duplicated,
      })
  }
  const configDir = hyprConfigDir(env)
  const configFile = join(configDir, 'hyprland.lua')
  const luaFile = join(configDir, 'hyprscope.lua')
  const command = panicCommand(env)
  const messageCmd = messageCommand(env)
  const annotateCmd = annotateCommand(env)
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
  if (keyTaken(foreign, annotateKey)) {
    throw new HyprscopeError(ErrorCode.BIND_FAILED, `Key ${annotateKey} is already bound`, { annotateKey })
  }
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const backupFile = `${configFile}.bak-hyprscope-${stamp}`
  const paths = messagePaths(messageDirectory(env))
  const annotateShortcutFile = annotateShortcutPath(env)
  // Read the records first so a failed install can put the old keys back
  // instead of leaving the overlays pointing at binds that do not exist.
  const previousShortcut = await readShortcut(paths.shortcutFile)
  const previousAnnotateShortcut = await readShortcut(annotateShortcutFile)
  /** Undo every change this install makes: config text, generated Lua, both shortcut records. */
  const rollback = async (): Promise<void> => {
    await writeFile(configFile, configText)
    await removeFile(luaFile)
    await restoreShortcut(paths.shortcutFile, previousShortcut)
    await restoreShortcut(annotateShortcutFile, previousAnnotateShortcut)
    // A reload failure during rollback must not hide the failure that caused it.
    await reloadConfig(session, env).catch(() => {})
  }
  try {
    await writeFile(luaFile,
      luaSource(normalizedKey(key), command, normalizedKey(messageKey), messageCmd, normalizedKey(annotateKey), annotateCmd),
      { mode: 0o644 })
    await copyFile(configFile, backupFile)
    const block = findBlock(configText, configFile)
    const nextBlock = configBlock(key, command, messageKey, messageCmd, annotateKey, annotateCmd)
    if (block === null) {
      await writeFile(configFile, `${configText}${nextBlock}`)
    } else {
      await writeFile(configFile, `${configText.slice(0, block.begin)}${nextBlock.trim()}${configText.slice(block.end)}`)
    }
    // The overlay reads both records, so they are written before the reload:
    // a reload that fails rolls them back together with the binds.
    await mkdir(paths.dir, { recursive: true, mode: 0o700 })
    await writeShortcut(paths.shortcutFile, normalizedKey(messageKey))
    await writeShortcut(annotateShortcutFile, normalizedKey(annotateKey))
    await reloadConfig(session, env)
    const errors = (await hyprctlJson<string[]>(session, 'configerrors')) ?? []
    const relevant = errors.filter(error => typeof error === 'string'
      && (error.includes('hyprscope') || error.includes('hyprlease')))
    if (relevant.length > 0) {
      throw new HyprscopeError(ErrorCode.BIND_FAILED, 'The managed binds broke the Hyprland configuration; restored the backup', {
        errors: relevant,
      })
    }
    const after = (await hyprctlJson<BindRecord[]>(session, 'binds')) ?? []
    const verified = after.some(bind => (bind.description ?? '').includes(BIND_DESCRIPTION))
    const messageVerified = after.some(bind => (bind.description ?? '').includes(MESSAGE_BIND_DESCRIPTION))
    const annotateVerified = after.some(bind => (bind.description ?? '').includes(ANNOTATE_BIND_DESCRIPTION))
    if (!verified || !messageVerified || !annotateVerified) {
      throw new HyprscopeError(ErrorCode.BIND_FAILED, 'The managed binds did not all appear in hyprctl binds; restored the backup', {
        key, messageKey, annotateKey, configFile, verified, messageVerified, annotateVerified,
      })
    }
    return {
      key: normalizedKey(key),
      command,
      messageKey: normalizedKey(messageKey),
      messageCommand: messageCmd,
      annotateKey: normalizedKey(annotateKey),
      annotateCommand: annotateCmd,
      luaFile,
      configFile,
      backupFile,
      verified,
      messageVerified,
      annotateVerified,
      shortcutFile: paths.shortcutFile,
      annotateShortcutFile,
    }
  } catch (error) {
    await rollback()
    if (error instanceof HyprscopeError) throw error
    throw new HyprscopeError(ErrorCode.BIND_FAILED, 'The managed binds could not be installed; restored the previous configuration', {
      configFile,
      cause: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Remove the managed binds, the desktop-message and desktop-annotate shortcut
 * records, and the generated Lua file.
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
  await removeFile(luaFile)
  await removeFile(join(configDir, 'hyprlease.lua'))
  await removeFile(messagePaths(messageDirectory(env)).shortcutFile)
  await removeFile(annotateShortcutPath(env))
  await reloadConfig(session, env)
  return { removed: true, backupFile }
}

/**
 * Delete a generated file, tolerating one that is already gone.
 * @param path File path.
 */
async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
