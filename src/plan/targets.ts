/**
 * Target and anchor resolution against a snapshot.
 *
 * Every location in a plan is derived at execution time from a window's current
 * rectangle, never baked into the plan as layout pixels.
 */
import type { Client, Monitor } from '../types.ts'
import type { AnchorPoint, AnchorRect, WindowTarget } from './model.ts'

/** One lean desktop snapshot used by preflight and verification. */
export interface Snapshot {
  observedAt: number
  clients: Client[]
  monitors: Monitor[]
  activeWindow: Client | null
}

/** Rectangle in global layout coordinates. */
export interface LayoutRect {
  x: number
  y: number
  width: number
  height: number
}

/** Result of matching a plan target against the current clients. */
export type TargetMatch =
  | { kind: 'ok'; client: Client }
  | { kind: 'ambiguous'; matches: Client[] }
  | { kind: 'missing' }

/**
 * Match a plan target against the client list.
 * @param target Selector from the plan.
 * @param clients Current clients.
 * @returns Exactly one client, several candidates, or none.
 */
export function matchTarget(target: WindowTarget, clients: Client[]): TargetMatch {
  if (target.id !== undefined) {
    const wanted = target.id.toLowerCase()
    const client = clients.find(entry => entry.windowId.toLowerCase() === wanted)
    return client === undefined ? { kind: 'missing' } : { kind: 'ok', client }
  }
  const matches = clients.filter(client => {
    if (target.app !== undefined && client.app !== target.app) return false
    if (target.title !== undefined && client.title !== target.title) return false
    return client.mapped
  })
  if (matches.length === 0) return { kind: 'missing' }
  if (matches.length > 1) return { kind: 'ambiguous', matches }
  return { kind: 'ok', client: matches[0]! }
}

/**
 * Resolve an anchor point against its window's content rectangle.
 * @param client Window the anchor belongs to.
 * @param point Unit-space offsets.
 * @returns Absolute layout position, clamped to the window rectangle.
 */
export function anchorPoint(client: Client, point: [number, number]): LayoutRect {
  const width = Math.max(1, client.size.width)
  const height = Math.max(1, client.size.height)
  const x = Math.round(client.position.x + point[0] * width)
  const y = Math.round(client.position.y + point[1] * height)
  return {
    x: clamp(x, client.position.x, client.position.x + width - 1),
    y: clamp(y, client.position.y, client.position.y + height - 1),
    width,
    height,
  }
}

/**
 * Resolve an anchored rectangle against its window's content rectangle.
 * @param client Window the region belongs to.
 * @param rect Unit-space offsets.
 * @returns Absolute layout region, clamped and at least one pixel wide.
 */
export function anchorRegion(client: Client, rect: [number, number, number, number]): LayoutRect {
  const [rx, ry, rw, rh] = rect
  const windowWidth = Math.max(1, client.size.width)
  const windowHeight = Math.max(1, client.size.height)
  const x = Math.round(client.position.x + rx * windowWidth)
  const y = Math.round(client.position.y + ry * windowHeight)
  const width = Math.max(1, Math.round(rw * windowWidth))
  const height = Math.max(1, Math.round(rh * windowHeight))
  const maxX = client.position.x + windowWidth
  const maxY = client.position.y + windowHeight
  const clampedX = clamp(x, client.position.x, maxX - 1)
  const clampedY = clamp(y, client.position.y, maxY - 1)
  return {
    x: clampedX,
    y: clampedY,
    width: Math.max(1, Math.min(width, maxX - clampedX)),
    height: Math.max(1, Math.min(height, maxY - clampedY)),
  }
}

/**
 * Resolve the pointer destination of a step.
 * @param at Anchored or absolute destination.
 * @param clients Current clients.
 * @returns Absolute coordinates, or null when the anchor window is missing.
 */
export function resolvePoint(at: AnchorPoint | { x: number; y: number }, clients: Client[]): { x: number; y: number } | null {
  if ('point' in at) {
    const match = matchTarget(at.window, clients)
    if (match.kind !== 'ok') return null
    const resolved = anchorPoint(match.client, at.point)
    return { x: resolved.x, y: resolved.y }
  }
  return { x: at.x, y: at.y }
}

/**
 * Resolve the active workspace name from the focused monitor.
 * @param monitors Current monitors.
 * @returns Workspace name, or null when no monitor reports focus.
 */
export function activeWorkspaceName(monitors: Monitor[]): string | null {
  const focused = monitors.find(monitor => monitor.focused) ?? monitors[0]
  return focused?.activeWorkspace?.name ?? null
}

/**
 * Clamp a value into an inclusive range.
 * @param value Candidate.
 * @param min Lower bound.
 * @param max Upper bound.
 * @returns Clamped value.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
