/**
 * Live world: the executor's only way to observe or change the desktop.
 *
 * Reads go through the read-only `hyprctl` allowlist, dispatch goes through the
 * lease-gated subset, and injection goes through the native helper. Observation
 * is also exposed as free functions so the recovery planner can look at the
 * desktop between two attempts without opening the event tap.
 */
import { ErrorCode, HyprscopeError } from '../errors.ts'
import { hyprctlJson } from '../hyprctl.ts'
import { capture, type CaptureResult } from '../screenshot.ts'
import { normalizeClient, normalizeMonitor } from '../state.ts'
import { dispatchWithLease, type DispatchRequest } from '../control/dispatch.ts'
import { Injector, type InjectCommand } from '../inject/injector.ts'
import { EventTap } from './tap.ts'
import type { Snapshot } from './targets.ts'
import type { Monitor, RawClient, RawCursor, RawMonitor, Session } from '../types.ts'

/** One capture request; the executor decides the destination. */
export interface CaptureRequest {
  output: string
  region?: { x: number; y: number; width: number; height: number }
}

/** Everything the executor is allowed to do to the desktop. */
export interface World {
  readonly tap: EventTap
  snapshot(): Promise<Snapshot>
  cursor(): Promise<{ x: number; y: number } | null>
  dispatch(request: DispatchRequest): Promise<void>
  inject(commands: InjectCommand[]): Promise<void>
  capture(request: CaptureRequest): Promise<CaptureResult>
  now(): number
  close(): Promise<void>
}

/**
 * Read a lean snapshot of clients, monitors, and focus.
 * @param session Discovered session.
 * @returns Current observation.
 */
export async function observeSnapshot(session: Session): Promise<Snapshot> {
  const [clients, monitors, active] = await Promise.all([
    hyprctlJson<RawClient[]>(session, 'clients'),
    hyprctlJson<RawMonitor[]>(session, 'monitors'),
    hyprctlJson<RawClient>(session, 'activewindow'),
  ])
  const activeRecord = active !== null && Object.keys(active).length > 0 ? normalizeClient(active) : null
  return {
    observedAt: Date.now(),
    clients: (clients ?? []).map(normalizeClient),
    monitors: (monitors ?? []).map(normalizeMonitor),
    activeWindow: activeRecord,
  }
}

/**
 * Read the pointer position in global layout coordinates.
 * @param session Discovered session.
 * @returns Pointer position, or null when unavailable.
 */
export async function observeCursor(session: Session): Promise<{ x: number; y: number } | null> {
  const cursor = await hyprctlJson<RawCursor>(session, 'cursorpos')
  if (cursor === null || typeof cursor.x !== 'number' || typeof cursor.y !== 'number') return null
  return { x: cursor.x, y: cursor.y }
}

/** Construction options for {@link LiveWorld}. */
export interface LiveWorldOptions {
  session: Session
  /** Lease guard run before every mutating call. */
  assertGrant: () => Promise<void>
  injectorBinary?: string
  /** Lease proof forwarded to the injection helper. */
  lease?: { id: string; statePath: string }
}

/** Global layout box used to map absolute coordinates into the injection extent. */
interface LayoutBox {
  originX: number
  originY: number
  width: number
  height: number
}

/** World backed by a real compositor. */
export class LiveWorld implements World {
  readonly tap: EventTap
  readonly #session: Session
  readonly #assertGrant: () => Promise<void>
  readonly #injectorBinary: string | undefined
  readonly #lease: { id: string; statePath: string } | undefined
  #injector: Injector | null = null
  #box: LayoutBox | null = null

  /**
   * @param options Session, lease guard, and optional helper path.
   */
  constructor(options: LiveWorldOptions) {
    this.#session = options.session
    this.#assertGrant = options.assertGrant
    this.#injectorBinary = options.injectorBinary
    this.#lease = options.lease
    this.tap = new EventTap(options.session)
    this.tap.start()
  }

  /** @returns Wall-clock milliseconds. */
  now(): number {
    return Date.now()
  }

  /** @returns Lean snapshot of clients, monitors, and focus. */
  async snapshot(): Promise<Snapshot> {
    const snapshot = await observeSnapshot(this.#session)
    this.#observe(snapshot.monitors)
    return snapshot
  }

  /** @returns Pointer position in global layout coordinates. */
  async cursor(): Promise<{ x: number; y: number } | null> {
    return observeCursor(this.#session)
  }

  /**
   * Run one allowlisted dispatcher under the lease guard.
   * @param request Dispatcher call.
   */
  async dispatch(request: DispatchRequest): Promise<void> {
    await dispatchWithLease(this.#session, this.#assertGrant, request)
  }

  /**
   * Apply one input batch; absolute coordinates are rebased onto the layout box.
   * @param commands Commands in order.
   */
  async inject(commands: InjectCommand[]): Promise<void> {
    if (commands.length === 0) return
    if (this.#box === null) {
      const snapshot = await this.snapshot()
      if (this.#box === null) {
        throw new HyprscopeError(ErrorCode.INJECTOR_FAILED, 'No monitor layout was observed before injection', {
          monitors: snapshot.monitors.length,
        })
      }
    }
    const layout = this.#box!
    // The helper maps absolute coordinates into the layout extent, so the
    // extent has to be the real layout box, not the helper's default.
    this.#injector ??= new Injector({
      session: this.#session,
      binary: this.#injectorBinary,
      extent: { width: layout.width, height: layout.height },
      lease: this.#lease,
    })
    const rebased = commands.map(command => {
      if (command.op !== 'move') return command
      return {
        op: 'move' as const,
        x: clamp(Math.round(command.x - layout.originX), 0, layout.width - 1),
        y: clamp(Math.round(command.y - layout.originY), 0, layout.height - 1),
      }
    })
    await this.#assertGrant()
    await this.#injector.send(rebased)
  }

  /**
   * Capture the layout or a region to a file.
   * @param request Destination and optional region.
   * @returns Capture metadata.
   */
  async capture(request: CaptureRequest): Promise<CaptureResult> {
    return capture(this.#session, { output: request.output, region: request.region })
  }

  /** Stop the tap and the injector. */
  async close(): Promise<void> {
    this.tap.close()
    if (this.#injector !== null) await this.#injector.close()
  }

  /**
   * Remember the monitor layout box used for absolute coordinates.
   * @param monitors Current monitors.
   */
  #observe(monitors: Monitor[]): void {
    const usable = monitors.filter(monitor => monitor.dpmsOn && monitor.size.width > 0 && monitor.size.height > 0)
    if (usable.length === 0) return
    const minX = Math.min(...usable.map(monitor => monitor.position.x))
    const minY = Math.min(...usable.map(monitor => monitor.position.y))
    const maxX = Math.max(...usable.map(monitor => monitor.position.x + monitor.size.width))
    const maxY = Math.max(...usable.map(monitor => monitor.position.y + monitor.size.height))
    this.#box = { originX: minX, originY: minY, width: maxX - minX, height: maxY - minY }
  }
}

/**
 * Clamp a number into an inclusive range.
 * @param value Candidate.
 * @param min Lower bound.
 * @param max Upper bound.
 * @returns Clamped value.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
