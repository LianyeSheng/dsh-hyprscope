/**
 * Event tap: one long-lived subscription to the compositor event socket that
 * distinguishes events caused by the executor's own commits from events that
 * arrive while it is idle.
 *
 * Attribution is a heuristic: the compositor reports no source for an event, so
 * the tap uses the commit window as the only discriminator. That is why every
 * mutating step also re-reads state instead of trusting the tap alone.
 */
import { EventStream } from '../events.ts'
import type { Session } from '../types.ts'

/** One event as observed by the tap. */
export interface TapEvent {
  event: string
  data: string
  at: number
  /** Whether the event arrived inside a commit window. */
  inCommit: boolean
}

/** Event kinds whose occurrence means desktop state changed. */
export const STATE_CHANGING_EVENTS: readonly string[] = [
  'workspace', 'activespecial', 'activewindow', 'openwindow', 'closewindow', 'movewindow',
  'moveworkspace', 'fullscreen', 'changefloatingmode', 'pin', 'monitoradded', 'monitorremoved',
  'monitorlayout', 'togglegroup', 'submap',
]

/** How a foreign event should be treated. */
export type ForeignClass = 'reworkspace' | 'refocus' | 'fatal' | 'ignore'

/**
 * Classify one foreign event.
 * @param event Event name.
 * @returns Repair action or fatal/ignore classification.
 */
export function classifyForeign(event: string): ForeignClass {
  switch (event) {
    case 'workspace':
    case 'activespecial':
    case 'moveworkspace':
      return 'reworkspace'
    case 'activewindow':
      return 'refocus'
    case 'windowtitle':
    case 'urgent':
    case 'activelayout':
    case 'focusedmon':
      return 'ignore'
    default:
      return 'fatal'
  }
}

/** Polling interval for consumers waiting on the tap. */
const WAIT_STEP_MS = 15

/** Queueing tap over one event socket connection. */
export class EventTap {
  readonly #session: Session
  #stream: EventStream | null = null
  #events: TapEvent[] = []
  #commitUntil = 0
  #closed = false
  #pump: Promise<void> | null = null

  /**
   * @param session Session whose event socket is watched.
   */
  constructor(session: Session) {
    this.#session = session
  }

  /** Open the subscription. */
  start(): void {
    if (this.#pump !== null) return
    this.#pump = this.#run()
  }

  /**
   * @param mark Position returned by {@link mark}.
   * @returns Events after the mark.
   */
  since(mark: number): TapEvent[] {
    return this.#events.slice(Math.max(0, mark))
  }

  /**
   * @returns Current event count, usable as a mark.
   */
  mark(): number {
    return this.#events.length
  }

  /**
   * Append a synthetic event. Production events come from the socket pump;
   * tests and future replay use this hook.
   * @param event Event name, payload, and optional timestamp.
   */
  inject(event: { event: string; data: string; at?: number }): void {
    const at = event.at ?? Date.now()
    this.#events.push({ event: event.event, data: event.data, at, inCommit: at <= this.#commitUntil })
  }

  /** Begin a commit window. */
  /**
   * @param durationMs How long arriving events are attributed to the commit.
   */
  beginCommit(durationMs: number): void {
    this.#commitUntil = Date.now() + Math.max(0, durationMs)
  }

  /** End the commit window early. */
  endCommit(): void {
    this.#commitUntil = 0
  }

  /**
   * Wait for one of the given event kinds after a mark.
   * @param kinds Event names to match.
   * @param timeoutMs Wait bound.
   * @param mark Position to search from.
   * @returns Matching event, or null on timeout or close.
   */
  async waitFor(kinds: readonly string[], timeoutMs: number, mark: number): Promise<TapEvent | null> {
    const deadline = Date.now() + timeoutMs
    let cursor = mark
    while (Date.now() < deadline) {
      const pending = this.#events.slice(cursor)
      for (const event of pending) {
        if (kinds.includes(event.event)) return event
      }
      cursor += pending.length
      if (this.#closed) return null
      await new Promise<void>(resolve => { setTimeout(resolve, WAIT_STEP_MS) })
    }
    return null
  }

  /** Stop the subscription. */
  close(): void {
    this.#closed = true
    this.#stream?.close()
  }

  /**
   * @returns Whether the underlying socket has ended.
   */
  get closed(): boolean {
    return this.#closed
  }

  /** Feed events into the buffer until the socket ends. */
  async #run(): Promise<void> {
    let stream: EventStream
    try {
      stream = new EventStream(this.#session)
    } catch {
      this.#closed = true
      return
    }
    this.#stream = stream
    while (!this.#closed) {
      let parsed
      try {
        parsed = await stream.next({})
      } catch {
        break
      }
      if (parsed === null) break
      const at = Date.now()
      this.#events.push({ event: parsed.event, data: parsed.data, at, inCommit: at <= this.#commitUntil })
    }
    this.#closed = true
  }
}
