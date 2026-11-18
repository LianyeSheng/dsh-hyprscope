/** Read-only subscription to the Hyprland event socket (`.socket2.sock`). */
import { connect as netConnect, type Socket } from 'node:net'
import { ErrorCode, HyprscopeError } from './errors.ts'

/** One parsed event-socket line. */
export interface ParsedEvent {
  event: string
  data: string
  raw: string
}

/** Socket factory, injectable for tests. */
export type ConnectFactory = (path: string) => Socket

/** Options for {@link EventStream.next}. */
export interface NextOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

/** Options for {@link waitForEvent}. */
export interface WaitOptions extends NextOptions {
  connect?: ConnectFactory
}

/** Pending reader inside {@link EventStream}. */
interface Waiter {
  resolve: (event: ParsedEvent | null) => void
  reject: (error: Error) => void
  timer?: NodeJS.Timeout
  signal?: AbortSignal
  onAbort?: () => void
}

/**
 * Parse one event-socket line of the form `event>>payload`.
 * @param line Raw line without its newline.
 * @returns Parsed event, or null when the line carries no `event>>payload` separator.
 */
export function parseEventLine(line: string): ParsedEvent | null {
  const raw = line.replace(/\r$/, '')
  if (raw.trim() === '') return null
  const index = raw.indexOf('>>')
  if (index <= 0) return null
  return { event: raw.slice(0, index), data: raw.slice(index + 2), raw }
}

/**
 * Split a payload without losing empty trailing fields.
 * @param data Payload after `>>`.
 * @returns Comma-separated fields.
 */
export function eventFields(data: string): string[] {
  return data.split(',')
}

/** Queueing connection to the compositor event socket. */
export class EventStream {
  readonly #socket: Socket
  #buffer = ''
  readonly #queue: ParsedEvent[] = []
  readonly #waiters: Waiter[] = []
  #closed = false
  #failure: Error | null = null

  /**
   * Open the event stream for a discovered session.
   * @param session Session or any record exposing the event socket path.
   * @param options Socket factory for tests.
   */
  constructor(session: Pick<import('./types.ts').Session, 'eventSocket'>, options: { connect?: ConnectFactory } = {}) {
    const connect = options.connect ?? netConnect
    this.#socket = connect(session.eventSocket)
    this.#socket.setEncoding('utf8')
    this.#socket.on('data', (chunk: string) => this.#feed(chunk))
    this.#socket.on('error', (error: Error) => { this.#failure = error; this.#close() })
    this.#socket.on('close', () => this.#close())
  }

  /** @returns Whether the socket has ended. */
  get closed(): boolean { return this.#closed }

  /** @param chunk Decoded socket data. */
  #feed(chunk: string): void {
    this.#buffer += chunk
    let index: number
    while ((index = this.#buffer.indexOf('\n')) >= 0) {
      const parsed = parseEventLine(this.#buffer.slice(0, index))
      this.#buffer = this.#buffer.slice(index + 1)
      if (parsed !== null) this.#queue.push(parsed)
    }
    this.#drain()
  }

  #close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#drain()
  }

  /**
   * Settle one waiter and release its timer and abort listener.
   * @param waiter Pending reader.
   * @param value Result or failure.
   */
  #settle(waiter: Waiter, value: ParsedEvent | null | Error): void {
    if (waiter.timer !== undefined) clearTimeout(waiter.timer)
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    if (value instanceof Error) waiter.reject(value)
    else waiter.resolve(value)
  }

  /** Hand queued events to readers, then end or fail the ones still waiting. */
  #drain(): void {
    while (this.#waiters.length > 0) {
      if (this.#queue.length > 0) {
        const waiter = this.#waiters.shift()
        if (waiter !== undefined) this.#settle(waiter, this.#queue.shift() ?? null)
        continue
      }
      if (!this.#closed) break
      const waiter = this.#waiters.shift()
      if (waiter !== undefined) this.#settle(waiter, this.#failure)
    }
  }

  /**
   * Wait for the next event.
   * @param options Per-read timeout and cancellation.
   * @returns Next event, or null after a clean stream end.
   */
  next(options: NextOptions = {}): Promise<ParsedEvent | null> {
    const queued = this.#queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.#failure !== null) return Promise.reject(this.#failure)
    if (this.#closed) return Promise.resolve(null)
    return new Promise<ParsedEvent | null>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject }
      const remove = () => {
        const index = this.#waiters.indexOf(waiter)
        if (index >= 0) this.#waiters.splice(index, 1)
      }
      if (options.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          remove()
          reject(new HyprscopeError(ErrorCode.TIMEOUT, `No event within ${options.timeoutMs}ms`, {
            timeoutMs: options.timeoutMs,
          }))
        }, options.timeoutMs)
      }
      if (options.signal !== undefined) {
        if (options.signal.aborted) {
          if (waiter.timer !== undefined) clearTimeout(waiter.timer)
          reject(new HyprscopeError(ErrorCode.TIMEOUT, 'Event wait aborted', { aborted: true }))
          return
        }
        waiter.signal = options.signal
        waiter.onAbort = () => {
          remove()
          if (waiter.timer !== undefined) clearTimeout(waiter.timer)
          reject(new HyprscopeError(ErrorCode.TIMEOUT, 'Event wait aborted', { aborted: true }))
        }
        options.signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      this.#waiters.push(waiter)
      this.#drain()
    })
  }

  /** Close the connection; pending readers settle with null. */
  close(): void {
    this.#socket.destroy()
  }
}

/**
 * Wait for the first event matching a predicate.
 * @param session Session that owns the event socket.
 * @param match Predicate deciding which event to return.
 * @param options Wait limit, cancellation, and socket factory.
 * @returns The matching event.
 */
export async function waitForEvent(
  session: Pick<import('./types.ts').Session, 'eventSocket'>,
  match: (event: ParsedEvent) => boolean,
  options: WaitOptions = {},
): Promise<ParsedEvent> {
  const stream = new EventStream(session, options)
  try {
    while (true) {
      const event = await stream.next({ timeoutMs: options.timeoutMs, signal: options.signal })
      if (event === null) {
        throw new HyprscopeError(ErrorCode.SESSION_GONE, 'Hyprland event socket closed before the event arrived')
      }
      if (match(event)) return event
    }
  } finally {
    stream.close()
  }
}
