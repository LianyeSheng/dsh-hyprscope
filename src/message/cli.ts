/** `hyprscope message`: the desktop-message composer and its overlay (never control). */
import { rm } from 'node:fs/promises'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import type { RenderLanguage } from '../i18n.ts'
import { discoverSession } from '../session.ts'
import type { Io } from '../cli.ts'
import { ensureMessageOverlay } from './overlay.ts'
import {
  ensureMessageDirectory, messageDirectory, messagePaths, readStatus, statusFresh, writeOpenRequest,
  writeQuitRequest, type MessagePaths, type OpenRequest,
} from './state.ts'

export const MESSAGE_USAGE = `hyprscope message — desktop message composer for a running DSH Host

Usage: hyprscope message <command> [options]

Commands:
  open          Open the message composer on the desktop (the shortcut runs this)
  annotate      Start the overlay for a desktop annotation session (screenshot, drawings, voice)
  overlay       Start the hint/composer overlay without opening the composer
  stop          Ask a running overlay to exit

Options:
  --json                 Machine-readable output
  --lang <zh|en>         Language of the overlay this command spawns (default zh or HYPRSCOPE_LANG)
  -h, --help             Show this help

The composer writes a message that the running DSH Host injects into the most
recently active session; the annotate command asks the same Host for a screenshot-and-voice
annotation session. The overlay belongs to the DSH hyprscope plugin and is not a
control surface.`

/** Parsed `hyprscope message` command line. */
export interface MessageOptions {
  json: boolean
  help: boolean
  lang?: RenderLanguage
}

/**
 * Parse the message command line without a dependency.
 * @param argv Arguments after `message`.
 * @returns Command, positional arguments and options.
 */
export function parseMessageArgs(argv: string[]): {
  command: string | undefined
  options: MessageOptions
  args: string[]
} {
  const options: MessageOptions = { json: false, help: false }
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '-h' || argument === '--help') { options.help = true; continue }
    if (argument === '--json') { options.json = true; continue }
    if (argument === '--lang' || argument.startsWith('--lang=')) {
      const value = argument === '--lang' ? argv[++index] : argument.slice('--lang='.length)
      if (value === undefined || (value !== 'zh' && value !== 'en')) {
        throw new HyprscopeError(ErrorCode.USAGE, '--lang expects "zh" or "en"')
      }
      options.lang = value
      continue
    }
    if (argument.startsWith('-')) throw new HyprscopeError(ErrorCode.USAGE, `Unknown option ${argument}`)
    positional.push(argument)
  }
  return { command: positional[0], options, args: positional.slice(1) }
}

/** @param options Parsed options. @param env Environment. @returns Render language. */
function languageOf(options: MessageOptions, env: NodeJS.ProcessEnv): RenderLanguage {
  if (options.lang !== undefined) return options.lang
  return env.HYPRSCOPE_LANG === 'en' ? 'en' : 'zh'
}

/**
 * Result of one `hyprscope message` command; additive fields stay stable for
 * scripts that only read the ones they asked for.
 */
export interface MessageCommandResult {
  command: 'open' | 'annotate' | 'overlay' | 'stop'
  /** Message directory the command used. */
  dir: string
  /** Overlay facts for the commands that start it. */
  overlay?: { pid: number | null; log: string }
  /** Overlay-open request written by `open` or `annotate`. */
  request?: OpenRequest
  /** Whether the DSH Host heartbeat looked live when the request was written. */
  dsh?: 'available' | 'unavailable'
}

/**
 * Report a failure the same way the observation surface does.
 * @param io Output targets.
 * @param error Failure to report.
 * @param json Whether JSON was requested.
 * @returns Process exit code.
 */
function fail(io: Io, error: unknown, json: boolean): number {
  const failure = error instanceof HyprscopeError ? error
    : new HyprscopeError(ErrorCode.COMMAND_FAILED, error instanceof Error ? error.message : String(error))
  if (json) {
    io.stderr.write(`${JSON.stringify({ error: { code: failure.code, message: failure.message, details: failure.details } })}\n`)
  } else {
    io.stderr.write(`hyprscope: ${failure.code}: ${failure.message}\n`)
  }
  return failure.code === ErrorCode.USAGE ? 2 : 1
}

/**
 * @param result Command result.
 * @returns Human-readable line.
 */
function render(result: MessageCommandResult): string {
  if (result.command === 'stop') return `desktop-message overlay asked to exit (${result.dir})`
  if (result.command === 'overlay') return `desktop-message overlay running (pid ${result.overlay?.pid ?? 'unknown'}, log ${result.overlay?.log ?? ''})`
  const state = result.dsh === 'available' ? 'DSH is running' : 'DSH is not running'
  if (result.command === 'annotate') return `desktop annotation session requested (${state}; ${result.dir})`
  return `desktop-message composer requested (${state}; ${result.dir})`
}

/**
 * Resolve the session, ensure the message directory and start the overlay.
 * @param lang Render language.
 * @param env Environment.
 * @returns Paths the command uses and the pid of the overlay process it spawned.
 */
async function ensureOverlayForCommand(
  lang: RenderLanguage,
  env: NodeJS.ProcessEnv,
): Promise<{ paths: MessagePaths; pid: number | null }> {
  const paths = messagePaths(messageDirectory(env))
  await ensureMessageDirectory(paths)
  const session = discoverSession({ env })
  const handle = await ensureMessageOverlay(session, { env, lang, paths })
  return { paths, pid: handle.pid }
}

/**
 * Run one `hyprscope message` command.
 * @param argv Arguments after `message`.
 * @param io Output targets.
 * @param env Environment to read.
 * @returns Process exit code.
 */
export async function main(
  argv: string[],
  io: Io = { stdout: process.stdout, stderr: process.stderr },
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let parsed: ReturnType<typeof parseMessageArgs>
  try {
    parsed = parseMessageArgs(argv)
  } catch (error) {
    return fail(io, error, false)
  }
  const { command, options } = parsed
  if (options.help || command === undefined) {
    if (command === undefined && !options.help) {
      io.stderr.write(MESSAGE_USAGE)
      return 2
    }
    io.stdout.write(MESSAGE_USAGE)
    return 0
  }
  if (command !== 'open' && command !== 'annotate' && command !== 'overlay' && command !== 'stop') {
    return fail(io, new HyprscopeError(ErrorCode.USAGE,
      `Unknown message command ${command}; expected open, annotate, overlay or stop`), options.json)
  }
  try {
    const lang = languageOf(options, env)
    if (command === 'stop') {
      const paths = messagePaths(messageDirectory(env))
      await ensureMessageDirectory(paths)
      await writeQuitRequest(paths)
      const result: MessageCommandResult = { command, dir: paths.dir }
      io.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${render(result)}\n`)
      return 0
    }
    const { paths, pid } = await ensureOverlayForCommand(lang, env)
    const overlay = { pid, log: paths.overlayLog }
    if (command === 'overlay') {
      const result: MessageCommandResult = { command, dir: paths.dir, overlay }
      io.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${render(result)}\n`)
      return 0
    }
    // A quit request left by an earlier stop must not close the overlay the
    // user just asked for.
    await rm(paths.quitFile, { force: true })
    const status = await readStatus(paths)
    const live = status !== null && status.alive && statusFresh(status)
    // The plugin consumes open.json and creates the annotate session itself;
    // the CLI only writes the request after the overlay is up.
    const request = await writeOpenRequest(paths, command === 'annotate' ? { mode: 'annotate' } : {})
    const result: MessageCommandResult = {
      command,
      dir: paths.dir,
      overlay,
      request,
      dsh: live ? 'available' : 'unavailable',
    }
    io.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : `${render(result)}\n`)
    return 0
  } catch (error) {
    return fail(io, error, options.json)
  }
}
