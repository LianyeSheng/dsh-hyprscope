/**
 * Client for the native `wl-inject` helper.
 *
 * One long-lived process speaks the virtual-pointer and virtual-keyboard
 * protocols; commands are written as JSON lines and acknowledged in order, so a
 * step's whole input batch travels through a single connection.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import type { Session } from '../types.ts'

/** One input command understood by the helper. */
export type InjectCommand =
  | { op: 'move'; x: number; y: number }
  | { op: 'moveRel'; dx: number; dy: number }
  | { op: 'button'; button: 'left' | 'right' | 'middle' | 'back' | 'forward'; action: 'press' | 'release' | 'click' }
  | { op: 'scroll'; value: number; axis: 'vertical' | 'horizontal' }
  | { op: 'chord'; keys: string[] }
  | { op: 'text'; text: string }
  | { op: 'sync' }

/** Options for {@link Injector}. */
export interface InjectorOptions {
  session: Pick<Session, 'runtimeDir' | 'signature' | 'waylandDisplay'>
  /** Helper path; defaults to `bin/wl-inject` next to the project. */
  binary?: string
  /** Global layout extent used to map absolute coordinates. */
  extent?: { width: number; height: number }
  /** Per-command timeout. */
  timeoutMs?: number
  /**
   * Lease proof forwarded to the helper. The helper refuses to inject unless
   * the lease state file says `granted` with this id and is bound to a
   * submitted plan, so a process cannot use the helper to approve its own
   * consent card.
   */
  lease?: { id: string; statePath: string }
}

/**
 * Build the helper argument list.
 * @param options Injector options.
 * @returns CLI arguments for `bin/wl-inject`.
 */
export function injectorArguments(options: InjectorOptions): string[] {
  const session = options.session
  const args = ['--runtime-dir', session.runtimeDir, '--signature', session.signature]
  if (session.waylandDisplay !== null) args.push('--display', session.waylandDisplay)
  if (options.extent !== undefined) {
    args.push('--extent-width', String(options.extent.width), '--extent-height', String(options.extent.height))
  }
  if (options.lease !== undefined) {
    args.push('--lease-state', options.lease.statePath, '--lease', options.lease.id)
  }
  return args
}

/** Pending acknowledgement for one command line. */
interface Pending {
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Default helper location inside the checkout. */
export function defaultInjectorBinary(): string {
  return new URL('../../bin/wl-inject', import.meta.url).pathname
}

/** Serializing client for one helper process. */
export class Injector {
  readonly #options: InjectorOptions
  #child: ChildProcessWithoutNullStreams | null = null
  #buffer = ''
  #stderr = ''
  #pending: Pending[] = []
  #failure: Error | null = null

  /**
   * @param options Session facts and helper location.
   */
  constructor(options: InjectorOptions) {
    this.#options = options
  }

  /**
   * Send a batch of commands and wait for every acknowledgement.
   * @param commands Commands applied in order.
   */
  async send(commands: InjectCommand[]): Promise<void> {
    if (commands.length === 0) return
    const child = this.#ensure()
    const timeoutMs = this.#options.timeoutMs ?? 5_000
    const waits = commands.map(() => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new HyprscopeError(ErrorCode.INJECTOR_FAILED, 'The injector did not acknowledge a command', { timeoutMs }))
      }, timeoutMs)
      this.#pending.push({ resolve, reject, timer })
    }))
    for (const command of commands) child.stdin.write(`${JSON.stringify(command)}\n`)
    await Promise.all(waits)
  }

  /** Close stdin and reap the helper. */
  async close(): Promise<void> {
    const child = this.#child
    if (child === null) return
    this.#child = null
    child.stdin.end()
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 1_000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    this.#fail(new HyprscopeError(ErrorCode.INJECTOR_FAILED, 'The injector connection closed'))
  }

  /**
   * @returns Whether the helper is running.
   */
  get running(): boolean {
    return this.#child !== null && this.#failure === null
  }

  /** Spawn the helper on first use. */
  #ensure(): ChildProcessWithoutNullStreams {
    if (this.#failure !== null) throw this.#failure
    if (this.#child !== null) return this.#child
    const binary = this.#options.binary ?? process.env.HYPRSCOPE_INJECT ?? defaultInjectorBinary()
    const args = injectorArguments(this.#options)
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      this.#failure = new HyprscopeError(ErrorCode.INJECTOR_FAILED, 'Could not start the input injector', {
        binary, cause: error instanceof Error ? error.message : String(error),
        hint: 'Run `pnpm run build:inject` to build bin/wl-inject',
      })
      throw this.#failure
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { this.#feed(chunk) })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { this.#stderr += chunk })
    child.once('error', (error: NodeJS.ErrnoException) => {
      this.#fail(new HyprscopeError(ErrorCode.INJECTOR_FAILED, 'The input injector failed to start', {
        binary, code: error.code ?? null,
        hint: error.code === 'ENOENT' ? 'Run `pnpm run build:inject` to build bin/wl-inject' : undefined,
      }))
    })
    child.once('exit', () => {
      this.#fail(new HyprscopeError(ErrorCode.INJECTOR_FAILED, 'The input injector exited', {
        stderr: this.#stderr.trim().slice(0, 500),
      }))
    })
    this.#child = child
    return child
  }

  /**
   * Consume acknowledgement lines.
   * @param chunk Decoded stdout data.
   */
  #feed(chunk: string): void {
    this.#buffer += chunk
    let index: number
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line === '') continue
      const pending = this.#pending.shift()
      if (pending === undefined) continue
      clearTimeout(pending.timer)
      let parsed: { ok?: boolean; error?: string } | null = null
      try {
        parsed = JSON.parse(line) as { ok?: boolean; error?: string }
      } catch {
        pending.reject(new HyprscopeError(ErrorCode.INJECTOR_FAILED, 'The injector returned malformed output', {
          sample: line.slice(0, 200),
        }))
        continue
      }
      if (parsed.ok === true) pending.resolve()
      else pending.reject(new HyprscopeError(ErrorCode.INJECTOR_FAILED, `Injector rejected a command: ${parsed.error ?? 'unknown'}`, {
        stderr: this.#stderr.trim().slice(0, 500),
      }))
    }
  }

  /**
   * Fail every outstanding acknowledgement.
   * @param error Failure to deliver.
   */
  #fail(error: Error): void {
    if (this.#failure === null && this.#child !== null) this.#failure = error
    const pending = this.#pending
    this.#pending = []
    for (const entry of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }
}
