/** Read-only `hyprctl` access: every command must pass one allowlist before it runs. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ErrorCode, HyprscopeError } from './errors.ts'
import type { Session } from './types.ts'

const run = promisify(execFile)

/** Options for one `hyprctl` call. */
export interface HyprctlOptions {
  timeoutMs?: number
  binary?: string
}

/**
 * `hyprctl` commands that only read compositor state.
 *
 * Commands that change the desktop (`dispatch`, `keyword`, `eval`, `repl`, `kill`,
 * `reload`, `setprop`, `output`, `plugin`, `setcursor`, `seterror`, `notify`,
 * `dismissnotify`, `hyprpaper`, `hyprsunset`) are intentionally absent: stage 0
 * observes and never acts.
 */
export const READ_ONLY_COMMANDS = [
  'version', 'status', 'clients', 'workspaces', 'monitors', 'layers', 'activewindow',
  'activeworkspace', 'cursorpos', 'devices', 'binds', 'getoption', 'globalshortcuts',
  'animations', 'configerrors', 'decorations', 'layouts', 'instances', 'splash',
] as const

/** A command name accepted by {@link assertReadOnlyCommand}. */
export type ReadOnlyCommand = typeof READ_ONLY_COMMANDS[number]

/**
 * Reject a command before any process starts.
 * @param command Candidate `hyprctl` command.
 * @returns The same command when it is read-only.
 */
export function assertReadOnlyCommand(command: string): ReadOnlyCommand {
  if (!(READ_ONLY_COMMANDS as readonly string[]).includes(command)) {
    throw new HyprscopeError(ErrorCode.READ_ONLY, `hyprctl ${command} is not a read-only command`, {
      command, allowed: [...READ_ONLY_COMMANDS],
    })
  }
  return command as ReadOnlyCommand
}

/**
 * Translate a failed `hyprctl` process into a coded failure.
 * @param error Failure from `execFile`.
 * @param command Command that failed.
 * @returns Coded failure.
 */
function translateFailure(error: unknown, command: string): HyprscopeError {
  const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; stderr?: string }
  const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : ''
  if (failure.code === 'ENOENT') {
    return new HyprscopeError(ErrorCode.COMMAND_FAILED, 'hyprctl is not installed or not on PATH', { command })
  }
  if (failure.killed === true || (failure.signal !== undefined && failure.signal !== null)) {
    return new HyprscopeError(ErrorCode.TIMEOUT, `hyprctl ${command} did not answer in time`, { command, stderr })
  }
  if (/HYPRLAND_INSTANCE_SIGNATURE not set|Couldn't connect|No such file/i.test(stderr)) {
    return new HyprscopeError(ErrorCode.SESSION_GONE, `Cannot reach the Hyprland instance for hyprctl ${command}`, { command, stderr })
  }
  return new HyprscopeError(ErrorCode.COMMAND_FAILED, `hyprctl ${command} failed`, {
    command, exitCode: failure.code ?? null, stderr,
  })
}

/**
 * Run one read-only `hyprctl` command against the discovered session.
 * @param session Discovered session.
 * @param command Read-only command name.
 * @param args Command arguments.
 * @param options Per-call limits and binary override.
 * @returns Raw standard output.
 */
export async function hyprctlText(
  session: Pick<Session, 'runtimeDir' | 'signature'>,
  command: string,
  args: string[] = [],
  options: HyprctlOptions = {},
): Promise<string> {
  assertReadOnlyCommand(command)
  const binary = options.binary ?? process.env.HYPRSCOPE_HYRPRCTL ?? 'hyprctl'
  const env = { ...process.env, XDG_RUNTIME_DIR: session.runtimeDir, HYPRLAND_INSTANCE_SIGNATURE: session.signature }
  try {
    const { stdout } = await run(binary, ['-j', command, ...args], {
      env, timeout: options.timeoutMs ?? 5000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8',
    })
    return stdout
  } catch (error) {
    throw translateFailure(error, command)
  }
}

/**
 * Run one read-only `hyprctl` command and parse its JSON output.
 * @param session Discovered session.
 * @param command Read-only command name.
 * @param args Command arguments.
 * @param options Per-call limits and binary override.
 * @returns Parsed JSON; null when the command prints nothing.
 */
export async function hyprctlJson<T>(
  session: Pick<Session, 'runtimeDir' | 'signature'>,
  command: string,
  args: string[] = [],
  options: HyprctlOptions = {},
): Promise<T | null> {
  const text = await hyprctlText(session, command, args, options)
  if (text.trim() === '') return null
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HyprscopeError(ErrorCode.BAD_OUTPUT, `hyprctl ${command} did not return JSON`, {
      command, sample: text.slice(0, 200),
    })
  }
}
