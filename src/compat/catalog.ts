/**
 * The capability catalog: code-owned ids, levels, and what each capability
 * gates.
 *
 * This table is the upper bound on what a machine may be allowed to do: the
 * baseline can only subtract from it. An id the baseline reports that this
 * table does not know is ignored with a warning.
 */
import { OP_SPECS, PREDICATE_SPECS, type PlanStep, type Predicate } from '../plan/model.ts'
import type { CapabilityId, CapabilityLevel, CapabilitySpec } from './types.ts'

/** Every capability, with its level, detection method, and consequence. */
export const CAPABILITY_SPECS: Readonly<Record<CapabilityId, CapabilitySpec>> = {
  'observe.hyprctl': {
    level: 'required',
    detection: 'version, status, clients, monitors, workspaces, layers, and activewindow all return parseable JSON',
    consequence: 'the observation layer stops working, so acceptance fails outright',
  },
  'observe.geometry': {
    level: 'required',
    detection: 'client geometry is integral and inside the layout spanned by the monitors, and a move reads back as the same coordinate system',
    consequence: 'the window.geometry predicate and geometry recovery stop working',
  },
  'observe.cursor': {
    level: 'required',
    detection: 'cursorpos returns a layout coordinate pair',
    consequence: 'the pointer.position predicate and pointer recovery stop working',
  },
  'dispatch.lua': {
    level: 'required',
    detection: 'the config provider is lua and one idempotent no-op dispatch is accepted without an error or warning',
    consequence: 'the whole dispatch subset fails, so control is unavailable',
  },
  'inject.pointer': {
    level: 'required',
    detection: 'the virtual pointer manager is advertised and a move lands within the pointer tolerance',
    consequence: 'pointer injection is unavailable, or the absolute landing point cannot be trusted',
  },
  'inject.keyboard': {
    level: 'required',
    detection: 'the virtual keyboard manager is advertised and an injected function key is received by the focused scratch client',
    consequence: 'keyboard injection is unavailable, and text and chord steps fail with it',
  },
  'events.socket': {
    level: 'required',
    detection: 'the event socket is connectable and opening and closing the scratch client yields its window events',
    consequence: 'external interference detection and waitEvent stop working, and takeover is unavailable',
  },
  'safety.failsafe-bind': {
    level: 'degraded',
    detection: 'the lua entry configuration is readable and the failsafe binding is visible in hyprctl binds',
    consequence: 'one hand-back path is missing; the ttl, done, and the banner button remain',
  },
  'dispatch.focus.window': {
    level: 'optional',
    detection: 'focusing a known window is accepted and reads back as focused',
    consequence: 'the focusWindow op, the window.focused predicate, and the focus restore template are unavailable',
  },
  'dispatch.focus.workspace': {
    level: 'optional',
    detection: 'focusing a known workspace is accepted and reads back as active',
    consequence: 'the workspace op, the workspace.active predicate, and the workspace restore template are unavailable',
  },
  'dispatch.window.move': {
    level: 'optional',
    detection: 'moving a floating window is accepted and reads back at the requested position',
    consequence: 'the moveWindow op and the move half of geometry recovery are unavailable',
  },
  'dispatch.window.resize': {
    level: 'optional',
    detection: 'resizing a floating window is accepted and reads back at the requested size',
    consequence: 'the resizeWindow op and the resize half of geometry recovery are unavailable',
  },
  'dispatch.window.float': {
    level: 'optional',
    detection: 'toggling floating is accepted and reads back in the client state',
    consequence: 'the float half of floatWindow and the floating half of the state restore template are unavailable',
  },
  'dispatch.window.pin': {
    level: 'optional',
    detection: 'toggling pinned is accepted and reads back in the client state',
    consequence: 'the pin half of floatWindow and the pinned half of the state restore template are unavailable',
  },
  'dispatch.window.fullscreen-state': {
    level: 'optional',
    detection: 'setting a fullscreen state is accepted and reads back in the client state',
    consequence: 'the fullscreenWindow op and the fullscreen half of the state restore template are unavailable',
  },
  'observe.window.modes': {
    level: 'optional',
    detection: 'clients carry numeric fullscreen and fullscreenClient fields',
    consequence: 'the window.state predicate cannot decide a fullscreen premise',
  },
  'capture.grim': {
    level: 'optional',
    detection: 'a region capture returns a PNG of the requested geometry',
    consequence: 'the screenshot op and the region.unchanged and region.changed predicates are unavailable',
  },
  'observe.lock': {
    level: 'optional',
    detection: 'the session lock field is reported by status when the lock file is readable',
    consequence: 'the lock field of the state snapshot is unavailable, but no predicate or op depends on it',
  },
  'dispatch.window.move-to-workspace': {
    level: 'optional',
    detection: 'moving a window to a workspace is accepted',
    consequence: 'no plan op uses it; it is recorded for the fingerprint only',
  },
} as const

/** Level of one capability, from the code catalog. */
export function capabilityLevel(id: CapabilityId): CapabilityLevel {
  return CAPABILITY_SPECS[id].level
}

/** Whether a value is a capability id this code knows. */
export function isCapabilityId(value: string): value is CapabilityId {
  return Object.hasOwn(CAPABILITY_SPECS, value)
}

/** All capability ids, in catalog order. */
export const CAPABILITY_IDS: readonly CapabilityId[] = Object.keys(CAPABILITY_SPECS) as CapabilityId[]

/**
 * Capabilities one predicate instance actually uses.
 *
 * `window.state` declares float, pin, and fullscreen together because the
 * restore template rebuilds all three, but a plan that asserts only
 * `floating` must not be rejected on a machine that cannot pin.
 * @param predicate Predicate instance from a plan.
 * @returns Capabilities the instance depends on.
 */
export function predicateCapabilities(predicate: Predicate): readonly CapabilityId[] {
  if (predicate.kind !== 'window.state') return PREDICATE_SPECS[predicate.kind].requires
  const required: CapabilityId[] = ['observe.hyprctl', 'observe.window.modes']
  if (predicate.floating !== undefined) required.push('dispatch.window.float')
  if (predicate.pinned !== undefined) required.push('dispatch.window.pin')
  if (predicate.fullscreen !== undefined || predicate.fullscreenClient !== undefined) {
    required.push('dispatch.window.fullscreen-state')
  }
  return required
}

/**
 * Capabilities one step actually uses.
 *
 * `floatWindow` declares both halves because a step may carry both, but a step
 * that sets only `floating` must not require `dispatch.window.pin`.
 * @param step Plan step.
 * @returns Capabilities the step depends on.
 */
export function stepCapabilities(step: PlanStep): readonly CapabilityId[] {
  if (step.op !== 'floatWindow') return OP_SPECS[step.op].requires
  const required: CapabilityId[] = []
  if (step.floating !== undefined) required.push('dispatch.window.float')
  if (step.pinned !== undefined) required.push('dispatch.window.pin')
  return required.length > 0 ? required : OP_SPECS.floatWindow.requires
}

/** Capabilities the restore templates depend on. */
export const RESTORE_CAPABILITIES: Readonly<Record<'workspace' | 'state' | 'geometry' | 'focus' | 'pointer', readonly CapabilityId[]>> = {
  workspace: ['dispatch.focus.workspace'],
  state: ['dispatch.window.float', 'dispatch.window.pin', 'dispatch.window.fullscreen-state'],
  geometry: ['dispatch.window.move', 'dispatch.window.resize'],
  focus: ['dispatch.focus.window'],
  pointer: ['inject.pointer'],
} as const
