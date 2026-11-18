/** Install the Hyprland failsafe shortcut that revokes a lease. */
import { execFile } from 'node:child_process'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import { hyprctlJson } from '../hyprctl.ts'
import { discoverSession } from '../session.ts'
import type { Session } from '../types.ts'
import { hyprscopeBin } from './overlay.ts'

const run = promisify(execFile)

/** Key combination bound to the failsafe release. */
export const DEFAULT_PANIC_KEY = 'SUPER + ALT + ESC'
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

/** Result of installing the failsafe bind. */
export interface BindInstallResult {
  key: string
  command: string
  luaFile: string
  configFile: string
  backupFile: string | null
  verified: boolean
}

/** Options for {@link installBind}. */
export interface BindOptions {
  key?: string
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
 * Build the Lua file that registers the failsafe bind.
 * @param key Key combination.
 * @param command Command run on the shortcut.
 * @returns Lua source.
 */
export function luaSource(key: string, command: string): string {
  return [
    `${MARKER_BEGIN}`,
    '-- Managed by `hyprscope control install-bind`; rerun the command instead of editing this file.',
    `hl.bind("${key}", hl.dsp.exec_cmd(${JSON.stringify(command)}), { description = ${JSON.stringify(BIND_DESCRIPTION)} })`,
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
 * The bind is inline because a `dofile`/`require` indirection is not executed
 * reliably by the Lua config provider on reload.
 * @param key Key combination.
 * @param command Command run on the shortcut.
 * @returns Lua source block.
 */
export function configBlock(key: string, command: string): string {
  return [
    '',
    `${MARKER_BEGIN}`,
    '-- Failsafe control release for `hyprscope control` (managed; remove with `hyprscope control uninstall-bind`).',
    `hl.bind("${normalizedKey(key)}", hl.dsp.exec_cmd(${JSON.stringify(command)}), { description = ${JSON.stringify(BIND_DESCRIPTION)} })`,
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

/**
 * Install the failsafe bind into the user's Hyprland configuration.
 * @param options Key, environment, and an optional discovered session.
 * @returns Install result including whether the bind was observed afterwards.
 */
export async function installBind(options: BindOptions = {}): Promise<BindInstallResult> {
  const env = options.env ?? process.env
  const session = options.session ?? discoverSession({ env })
  const key = options.key ?? DEFAULT_PANIC_KEY
  const configDir = hyprConfigDir(env)
  const configFile = join(configDir, 'hyprland.lua')
  const luaFile = join(configDir, 'hyprscope.lua')
  const command = panicCommand(env)
  let configText: string
  try {
    configText = await readFile(configFile, 'utf8')
  } catch {
    throw new HyprscopeError(ErrorCode.BIND_FAILED, `No Hyprland Lua config at ${configFile}`, { configFile })
  }
  const binds = (await hyprctlJson<BindRecord[]>(session, 'binds')) ?? []
  if (keyTaken(binds, key)) {
    throw new HyprscopeError(ErrorCode.BIND_FAILED, `Key ${key} is already bound`, { key })
  }
  await writeFile(luaFile, luaSource(normalizedKey(key), command), { mode: 0o644 })
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const backupFile = `${configFile}.bak-hyprscope-${stamp}`
  await copyFile(configFile, backupFile)
  const block = findBlock(configText, configFile)
  if (block === null) {
    await writeFile(configFile, `${configText}${configBlock(key, command)}`)
  } else {
    await writeFile(configFile, `${configText.slice(0, block.begin)}${configBlock(key, command).trim()}${configText.slice(block.end)}`)
  }
  await reloadConfig(session, env)
  const errors = (await hyprctlJson<string[]>(session, 'configerrors')) ?? []
  const relevant = errors.filter(error => typeof error === 'string'
    && (error.includes('hyprscope') || error.includes('hyprlease')))
  if (relevant.length > 0) {
    await writeFile(configFile, configText)
    await reloadConfig(session, env)
    throw new HyprscopeError(ErrorCode.BIND_FAILED, 'The failsafe bind broke the Hyprland configuration; restored the backup', {
      errors: relevant,
    })
  }
  const after = (await hyprctlJson<BindRecord[]>(session, 'binds')) ?? []
  const verified = after.some(bind => (bind.description ?? '').includes(BIND_DESCRIPTION))
  if (!verified) {
    await writeFile(configFile, configText)
    await reloadConfig(session, env)
    throw new HyprscopeError(ErrorCode.BIND_FAILED, 'The failsafe bind did not appear in hyprctl binds; restored the backup', {
      key, configFile,
    })
  }
  return { key: normalizedKey(key), command, luaFile, configFile, backupFile, verified }
}

/**
 * Remove the failsafe bind and restore the configuration block.
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
