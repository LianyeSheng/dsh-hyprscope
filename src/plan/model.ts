/**
 * Plan model: the fixed predicate and operation catalogs shared by validation,
 * execution, and the documentation.
 *
 * Plans are authored by an agent but interpreted by a deterministic executor.
 * Two tables below are therefore code-owned: an author may instantiate them
 * with parameters, never extend them or change their severity.
 *
 * Every declared `requires` entry is an *invariant*: the executor checks it
 * before each step, and when one breaks the tool may re-establish it by itself
 * (see `recover.ts`). Whether a kind can be re-established is a property of the
 * catalog here, not of the plan document.
 */

import type { CapabilityId } from '../compat/types.ts'

/** Window selector: an address wins; otherwise app/title must match exactly one client. */
export interface WindowTarget {
  id?: string
  app?: string
  title?: string
}

/** Pointer position relative to a target window's rectangle, in 0..1 units. */
export interface AnchorPoint {
  window: WindowTarget
  point: [number, number]
}

/** Absolute layout coordinate. */
export interface AbsolutePoint {
  x: number
  y: number
}

/** Region relative to a target window's rectangle, in 0..1 units. */
export interface AnchorRect {
  window: WindowTarget
  rect: [number, number, number, number]
}

/** Predicate kinds the executor knows how to evaluate. */
export type PredicateKind =
  | 'lease.valid'
  | 'time.budget'
  | 'window.exists'
  | 'window.focused'
  | 'window.geometry'
  | 'window.state'
  | 'workspace.active'
  | 'monitor.config'
  | 'clients.set'
  | 'pointer.position'
  | 'region.unchanged'
  | 'region.changed'
  | 'no.foreign_event'

/**
 * One predicate instance. Which fields are meaningful depends on `kind`; the
 * validator rejects parameters a kind does not use.
 */
export interface Predicate {
  kind: PredicateKind
  target?: WindowTarget
  name?: string
  /** Absolute pointer position, in layout pixels. */
  x?: number
  y?: number
  /** Window-relative pointer position, in 0..1 units of the window rectangle. */
  point?: [number, number]
  width?: number
  height?: number
  scale?: number
  tol?: number
  floating?: boolean
  pinned?: boolean
  /** Internal fullscreen mode: 0 none, 1 fullscreen, 2 maximized. */
  fullscreen?: 0 | 1 | 2
  /** Client-side fullscreen mode, same encoding. */
  fullscreenClient?: 0 | 1 | 2
  ids?: string[]
  rect?: [number, number, number, number]
  label?: string
}

/** How expensive a predicate is to evaluate. */
export type PredicateCost = 'cached' | 'state' | 'pointer' | 'capture'

/** How the tool re-establishes one class of broken premise. */
export type RestoreKind = 'workspace' | 'state' | 'geometry' | 'focus' | 'pointer'

/** Code-owned behavior of one predicate kind. */
export interface PredicateSpec {
  /** Evaluation cost; cheap kinds run first. */
  cost: PredicateCost
  /** Phases the kind may appear in; implicit kinds never appear in a plan. */
  phases: readonly ('requires' | 'expect')[]
  /**
   * Whether a broken instance of this kind can be re-established by the tool
   * alone. `false` means the plan stops: the assumption involves something the
   * tool cannot rebuild (a closed window, application state, a monitor change).
   */
  restorable: boolean
  /** Code-owned restore template; `null` when `restorable` is false. */
  restore: RestoreKind | null
  /** Capabilities this predicate depends on; validated against the baseline. */
  requires: readonly CapabilityId[]
  /** Whether the executor adds the predicate to every step. */
  implicit: boolean
}

/** Predicate catalog: kind, cost, phase, restorability, restore template, and capabilities. */
export const PREDICATE_SPECS: Readonly<Record<PredicateKind, PredicateSpec>> = {
  'lease.valid': { cost: 'cached', phases: [], restorable: false, restore: null, requires: [], implicit: true },
  'time.budget': { cost: 'cached', phases: [], restorable: false, restore: null, requires: [], implicit: true },
  'window.exists': {
    cost: 'state', phases: ['requires', 'expect'], restorable: false, restore: null,
    requires: ['observe.hyprctl'], implicit: false,
  },
  'window.focused': {
    cost: 'state', phases: ['requires', 'expect'], restorable: true, restore: 'focus',
    requires: ['observe.hyprctl', 'dispatch.focus.window'], implicit: false,
  },
  'window.geometry': {
    cost: 'state', phases: ['requires', 'expect'], restorable: true, restore: 'geometry',
    requires: ['observe.geometry', 'dispatch.window.move', 'dispatch.window.resize'], implicit: false,
  },
  'window.state': {
    cost: 'state', phases: ['requires', 'expect'], restorable: true, restore: 'state',
    requires: [
      'observe.hyprctl', 'observe.window.modes', 'dispatch.window.float',
      'dispatch.window.pin', 'dispatch.window.fullscreen-state',
    ],
    implicit: false,
  },
  'workspace.active': {
    cost: 'state', phases: ['requires', 'expect'], restorable: true, restore: 'workspace',
    requires: ['observe.hyprctl', 'dispatch.focus.workspace'], implicit: false,
  },
  'monitor.config': {
    cost: 'state', phases: ['requires', 'expect'], restorable: false, restore: null,
    requires: ['observe.hyprctl'], implicit: false,
  },
  'clients.set': {
    cost: 'state', phases: ['requires'], restorable: false, restore: null,
    requires: ['observe.hyprctl'], implicit: false,
  },
  'pointer.position': {
    cost: 'pointer', phases: ['requires'], restorable: true, restore: 'pointer',
    requires: ['observe.cursor', 'inject.pointer'], implicit: false,
  },
  'region.unchanged': {
    cost: 'capture', phases: ['requires'], restorable: false, restore: null,
    requires: ['capture.grim'], implicit: false,
  },
  'region.changed': {
    cost: 'capture', phases: ['expect'], restorable: false, restore: null,
    requires: ['capture.grim'], implicit: false,
  },
  'no.foreign_event': {
    cost: 'cached', phases: [], restorable: false, restore: null,
    requires: ['events.socket'], implicit: true,
  },
} as const

/** Step operations the executor implements. */
export type StepOp =
  | 'movePointer'
  | 'click'
  | 'scroll'
  | 'chord'
  | 'text'
  | 'focusWindow'
  | 'workspace'
  | 'moveWindow'
  | 'resizeWindow'
  | 'floatWindow'
  | 'fullscreenWindow'
  | 'screenshot'
  | 'pause'
  | 'assert'
  | 'waitEvent'

/** Event kinds a `waitEvent` step accepts. */
export type EventKind = 'activewindow' | 'workspace' | 'openwindow' | 'closewindow'

/** One plan step: an operation, its preconditions, and its expectations. */
export interface PlanStep {
  op: StepOp
  at?: AnchorPoint | AbsolutePoint
  button?: 'left' | 'right' | 'middle' | 'back' | 'forward'
  count?: number
  value?: number
  axis?: 'vertical' | 'horizontal'
  keys?: string[]
  text?: string
  target?: WindowTarget
  name?: string
  x?: number
  y?: number
  width?: number
  height?: number
  /** Desired internal fullscreen mode for `fullscreenWindow`. */
  internal?: 0 | 1 | 2
  /** Desired client fullscreen mode for `fullscreenWindow`. */
  client?: 0 | 1 | 2
  floating?: boolean
  pinned?: boolean
  label?: string
  region?: AnchorRect
  ms?: number
  kind?: EventKind
  timeoutMs?: number
  requires?: Predicate[]
  expect?: Predicate[]
}

/** Proof that a plan is a code-derived recovery of an interrupted plan. */
export interface PlanLineage {
  rootPlanId: string
  /** Attempt number: 1 is the first recovery. */
  attempt: number
  /** Step index that was interrupted. */
  interruptedAtStep: number
  /** Premises the recovery set out to re-establish. */
  broken: string[]
}

/** A complete plan, already validated and defaulted. */
export interface Plan {
  version: 1
  id: string
  reason: string
  summary: string | null
  workspace: string | null
  budgetMs: number
  settleMs: number
  interferencePromptMs: number
  steps: PlanStep[]
  /**
   * Present only on plans the tool derived from an interrupted run. External
   * plan documents may not carry it: a lineage is created, never authored.
   */
  lineage?: PlanLineage
}

/** Code-owned behavior of one operation. */
export interface OpSpec {
  op: StepOp
  /** Whether the op changes desktop state. */
  mutating: boolean
  /** Whether applying it twice is equivalent to applying it once. */
  idempotent: boolean
  /** Whether the step must declare at least one `requires`. */
  requiresDeclared: boolean
  /** Whether the step must declare at least one `expect`. */
  requiresExpect: boolean
  /** Whether the step must name a target window. */
  needsTarget: boolean
  /** Predicate kinds the step must declare in `requires`, owned by the op. */
  requiredKinds?: readonly PredicateKind[]
  /** Capabilities the op itself depends on; validated against the baseline. */
  requires: readonly CapabilityId[]
}

/** Operation catalog: mutating, idempotency, assertion requirements, and capabilities. */
export const OP_SPECS: Readonly<Record<StepOp, OpSpec>> = {
  movePointer: {
    op: 'movePointer', mutating: true, idempotent: true, requiresDeclared: false, requiresExpect: false,
    needsTarget: false, requires: ['inject.pointer'],
  },
  click: {
    op: 'click', mutating: true, idempotent: false, requiresDeclared: true, requiresExpect: true, needsTarget: false,
    requiredKinds: ['window.focused', 'window.geometry'], requires: ['inject.pointer'],
  },
  scroll: {
    op: 'scroll', mutating: true, idempotent: false, requiresDeclared: true, requiresExpect: true,
    needsTarget: false, requires: ['inject.pointer'],
  },
  chord: {
    op: 'chord', mutating: true, idempotent: false, requiresDeclared: true, requiresExpect: true,
    needsTarget: false, requires: ['inject.keyboard'],
  },
  text: {
    op: 'text', mutating: true, idempotent: false, requiresDeclared: true, requiresExpect: true,
    needsTarget: false, requires: ['inject.keyboard'],
  },
  focusWindow: {
    op: 'focusWindow', mutating: true, idempotent: true, requiresDeclared: true, requiresExpect: false,
    needsTarget: true, requires: ['dispatch.focus.window'],
  },
  workspace: {
    op: 'workspace', mutating: true, idempotent: true, requiresDeclared: false, requiresExpect: false,
    needsTarget: false, requires: ['dispatch.focus.workspace'],
  },
  moveWindow: {
    op: 'moveWindow', mutating: true, idempotent: true, requiresDeclared: true, requiresExpect: false,
    needsTarget: true, requires: ['dispatch.window.move'],
  },
  resizeWindow: {
    op: 'resizeWindow', mutating: true, idempotent: true, requiresDeclared: true, requiresExpect: false,
    needsTarget: true, requires: ['dispatch.window.resize'],
  },
  floatWindow: {
    op: 'floatWindow', mutating: true, idempotent: true, requiresDeclared: true, requiresExpect: false,
    needsTarget: true, requires: ['dispatch.window.float', 'dispatch.window.pin'],
  },
  fullscreenWindow: {
    op: 'fullscreenWindow', mutating: true, idempotent: true, requiresDeclared: true, requiresExpect: false,
    needsTarget: true, requires: ['dispatch.window.fullscreen-state'],
  },
  screenshot: {
    op: 'screenshot', mutating: false, idempotent: true, requiresDeclared: false, requiresExpect: false,
    needsTarget: false, requires: ['capture.grim'],
  },
  pause: {
    op: 'pause', mutating: false, idempotent: true, requiresDeclared: false, requiresExpect: false,
    needsTarget: false, requires: [],
  },
  assert: {
    op: 'assert', mutating: false, idempotent: true, requiresDeclared: false, requiresExpect: false,
    needsTarget: false, requires: [],
  },
  waitEvent: {
    op: 'waitEvent', mutating: false, idempotent: true, requiresDeclared: false, requiresExpect: false,
    needsTarget: false, requires: ['events.socket'],
  },
} as const

/** Numeric and structural bounds enforced by validation. */
export const PLAN_LIMITS = {
  maxSteps: 64,
  minBudgetMs: 500,
  maxBudgetMs: 30_000,
  defaultBudgetMs: 8_000,
  minSettleMs: 50,
  maxSettleMs: 5_000,
  defaultSettleMs: 600,
  minInterferencePromptMs: 1_000,
  maxInterferencePromptMs: 60_000,
  defaultInterferencePromptMs: 12_000,
  /** Recovery attempts the consent card may authorize by default. */
  defaultMaxResumes: 1,
  /** Hard cap on recovery attempts in one lease. */
  maxResumes: 3,
  maxTextChars: 4_096,
  maxSingleTextChars: 2_000,
  maxPauseMs: 1_000,
  maxWaitEventMs: 5_000,
  defaultWaitEventMs: 1_000,
} as const

/**
 * Test whether a value is an anchored point.
 * @param value Candidate `at` field.
 * @returns Whether it carries a window-relative point.
 */
export function isAnchorPoint(value: unknown): value is AnchorPoint {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return Array.isArray(record.point) && typeof record.window === 'object' && record.window !== null
}

/**
 * Test whether a value is an absolute point.
 * @param value Candidate `at` field.
 * @returns Whether it carries layout coordinates.
 */
export function isAbsolutePoint(value: unknown): value is AbsolutePoint {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.x === 'number' && typeof record.y === 'number' && record.point === undefined
}
