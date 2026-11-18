/**
 * The capability probe's measurement plan.
 *
 * The probe no longer drives the desktop from its own injector. It builds this
 * plan from facts it already measured read-only, shows it on the lease consent
 * card, and submits it to the normal executor: an ordinary validated plan
 * document, in which every selector is either the probe's own scratch client
 * (that is, a symbolic selector) or the address it read before it started.
 * No step may name a user window.
 */
import { tr, type RenderLanguage } from '../i18n.ts'
import type { Plan, PlanStep, Predicate, WindowTarget, AnchorPoint } from '../plan/model.ts'
import type { CapabilityId } from './types.ts'

/** Window selector of the probe's own scratch client. */
export const PROBE_WINDOW: WindowTarget = { app: 'hyprscope-scratch', title: 'hyprscope-scratch' }

/** Identifier of the measurement plan. */
export const PROBE_PLAN_ID = 'capability-probe'

/** Wall-clock budget of the measurement plan. */
export const PROBE_PLAN_BUDGET_MS = 25_000

/** Size the resize step requests. */
export const PROBE_RESIZE = { width: 360, height: 240 } as const

/** Workspace names the plan validator accepts and the probe may dispatch. */
const WORKSPACE_NAME = /^[A-Za-z0-9._-]{1,32}$/

/** Window address format Hyprland reports and the validator accepts. */
const WINDOW_ADDRESS = /^0x[0-9a-fA-F]+$/

/** Premise of every step that needs the scratch window to be mapped. */
const windowExists: Predicate = { kind: 'window.exists', target: PROBE_WINDOW }

/** Premise of the steps that only work while the scratch window has focus. */
const windowFocused: Predicate = { kind: 'window.focused', target: PROBE_WINDOW }

/** Pointer destination at the centre of the scratch window. */
const anchorPoint: AnchorPoint = { window: PROBE_WINDOW, point: [0.5, 0.5] }

/** Read-back premise that the pointer really landed on the scratch window. */
const pointerAtCentre: Predicate = {
  kind: 'pointer.position', target: PROBE_WINDOW, point: [0.5, 0.5], tol: 2,
}

/** Window state fields a `window.state` premise may assert. */
type WindowStateFields = Pick<Predicate, 'floating' | 'pinned' | 'fullscreen' | 'fullscreenClient'>

/**
 * Build a `window.state` premise on the scratch window.
 * @param fields Window state to assert.
 * @returns Predicate instance.
 */
function windowState(fields: WindowStateFields): Predicate {
  return { kind: 'window.state', target: PROBE_WINDOW, ...fields }
}

/** Facts the probe already measured without touching the desktop. */
export interface ProbePlanInput {
  /** Active workspace name before the probe started, when hyprctl reported one. */
  workspace: string | null
  /** Global layout origin (min x/y over the monitors), when monitors were readable. */
  origin: { x: number; y: number } | null
  /** Active window address before the probe started, when one existed. */
  restoreWindow: string | null
  /** Language of the measurement plan's human description; defaults to Chinese. */
  lang?: RenderLanguage
}

/** A post-run observation that proves an effect landed. */
export type ProbeVerify = 'key-pressed' | 'geometry-position' | 'geometry-size'

/** One capability check a plan step (or step pair) supplies. */
export interface ProbeCheckSpec {
  capability: CapabilityId
  /** Unique within the capability. */
  name: string
  /** 0-based step indexes that must commit for the check to pass. */
  steps: number[]
  verify?: ProbeVerify
}

/** A measurement plan, its checks, and what the environment did not allow. */
export interface ProbePlan {
  plan: Plan
  checks: ProbeCheckSpec[]
  moveTarget: { x: number; y: number } | null
  resizeTarget: { width: number; height: number } | null
  /** Measurements the environment did not allow, with the reason. */
  limitations: { capability: CapabilityId; detail: string }[]
}

/**
 * Build the probe's measurement plan from facts measured read-only.
 * @param input Workspace, layout origin, and restore window the probe read.
 * @returns The validated-plan candidate, its checks, geometry targets, and limitations.
 */
export function buildProbePlan(input: ProbePlanInput): ProbePlan {
  const workspace = input.workspace !== null && WORKSPACE_NAME.test(input.workspace) ? input.workspace : null
  const restoreWindow = input.restoreWindow !== null && WINDOW_ADDRESS.test(input.restoreWindow)
    ? input.restoreWindow.toLowerCase()
    : null
  const steps: PlanStep[] = []
  const checks: ProbeCheckSpec[] = []
  const limitations: ProbePlan['limitations'] = []
  let moveTarget: ProbePlan['moveTarget'] = null
  let resizeTarget: ProbePlan['resizeTarget'] = null

  if (workspace !== null) {
    const index = steps.length
    steps.push({ op: 'workspace', name: workspace, expect: [{ kind: 'workspace.active', name: workspace }] })
    checks.push({ capability: 'dispatch.lua', name: 'idempotent-workspace-dispatch', steps: [index] })
    checks.push({ capability: 'dispatch.focus.workspace', name: 'focus-active-workspace', steps: [index] })
  }

  const focusIndex = steps.length
  steps.push({ op: 'focusWindow', target: PROBE_WINDOW, requires: [windowExists], expect: [windowFocused] })
  checks.push({ capability: 'dispatch.focus.window', name: 'focus-scratch', steps: [focusIndex] })

  const movePointerIndex = steps.length
  steps.push({ op: 'movePointer', at: anchorPoint })
  // The compositor applies the injected move asynchronously, and `assert` has no
  // settle loop; a short pause keeps the read-back from racing the injection.
  steps.push({ op: 'pause', ms: 200 })
  const assertIndex = steps.length
  steps.push({ op: 'assert', requires: [pointerAtCentre] })
  checks.push({ capability: 'inject.pointer', name: 'pointer-move', steps: [movePointerIndex, assertIndex] })

  const chordIndex = steps.length
  steps.push({ op: 'chord', keys: ['F12'], requires: [windowFocused], expect: [windowExists] })
  checks.push({ capability: 'inject.keyboard', name: 'key-f12', steps: [chordIndex], verify: 'key-pressed' })

  const floatOffIndex = steps.length
  steps.push({
    op: 'floatWindow', target: PROBE_WINDOW, floating: false,
    requires: [windowExists], expect: [windowState({ floating: false })],
  })
  checks.push({ capability: 'dispatch.window.float', name: 'float-off', steps: [floatOffIndex] })

  const floatOnIndex = steps.length
  steps.push({
    op: 'floatWindow', target: PROBE_WINDOW, floating: true,
    requires: [windowExists, windowState({ floating: false })], expect: [windowState({ floating: true })],
  })
  checks.push({ capability: 'dispatch.window.float', name: 'float-on', steps: [floatOnIndex] })

  const pinOnIndex = steps.length
  steps.push({
    op: 'floatWindow', target: PROBE_WINDOW, pinned: true,
    requires: [windowExists], expect: [windowState({ pinned: true })],
  })
  checks.push({ capability: 'dispatch.window.pin', name: 'pin-on', steps: [pinOnIndex] })

  const pinOffIndex = steps.length
  steps.push({
    op: 'floatWindow', target: PROBE_WINDOW, pinned: false,
    requires: [windowExists], expect: [windowState({ pinned: false })],
  })
  checks.push({ capability: 'dispatch.window.pin', name: 'pin-off', steps: [pinOffIndex] })

  const fullscreenOnIndex = steps.length
  steps.push({
    op: 'fullscreenWindow', target: PROBE_WINDOW, internal: 1, client: 0,
    requires: [windowExists], expect: [windowState({ fullscreen: 1, fullscreenClient: 0 })],
  })
  checks.push({ capability: 'dispatch.window.fullscreen-state', name: 'fullscreen-on', steps: [fullscreenOnIndex] })

  const fullscreenOffIndex = steps.length
  steps.push({
    op: 'fullscreenWindow', target: PROBE_WINDOW, internal: 0, client: 0,
    requires: [windowExists], expect: [windowState({ fullscreen: 0, fullscreenClient: 0 })],
  })
  checks.push({ capability: 'dispatch.window.fullscreen-state', name: 'fullscreen-off', steps: [fullscreenOffIndex] })

  // Resize before the move: the compositor keeps a floating window's centre when
  // it resizes, so a later move is what actually decides the final position the
  // probe reads back.
  const resizeIndex = steps.length
  steps.push({
    op: 'resizeWindow', target: PROBE_WINDOW, width: PROBE_RESIZE.width, height: PROBE_RESIZE.height,
    requires: [windowExists, windowState({ floating: true })],
  })
  checks.push({ capability: 'dispatch.window.resize', name: 'resize-scratch', steps: [resizeIndex], verify: 'geometry-size' })
  resizeTarget = { width: PROBE_RESIZE.width, height: PROBE_RESIZE.height }

  if (input.origin !== null) {
    const origin = input.origin
    const index = steps.length
    steps.push({
      op: 'moveWindow', target: PROBE_WINDOW, x: origin.x, y: origin.y,
      requires: [windowExists, windowState({ floating: true })],
    })
    checks.push({ capability: 'dispatch.window.move', name: 'move-scratch', steps: [index], verify: 'geometry-position' })
    moveTarget = { x: origin.x, y: origin.y }
  } else {
    limitations.push({
      capability: 'dispatch.window.move',
      detail: 'no monitor layout was read, so the move round trip has no destination',
    })
  }

  // Capture the scratch window through the foreign-toplevel path, not through
  // the composited output: this is the one round trip that measures whether a
  // window capture works on this machine. A short pause lets the resize and
  // move above settle into the window's surface before the capture session is
  // opened, so the measurement does not race a size change.
  steps.push({ op: 'pause', ms: 250 })
  const windowCaptureIndex = steps.length
  steps.push({ op: 'screenshot', label: 'window', window: PROBE_WINDOW })
  checks.push({ capability: 'capture.window', name: 'window-capture', steps: [windowCaptureIndex] })

  // Restore what the probe changed: the workspace, then the window it found.
  // Neither step is measured; they only give the desktop back.
  if (workspace !== null) steps.push({ op: 'workspace', name: workspace })
  if (restoreWindow !== null) {
    const target: WindowTarget = { id: restoreWindow }
    steps.push({ op: 'focusWindow', target, requires: [{ kind: 'window.exists', target }] })
  }

  if (workspace === null) {
    const detail = 'the active workspace name was not read or is not a dispatchable workspace name'
    limitations.push({ capability: 'dispatch.lua', detail })
    limitations.push({ capability: 'dispatch.focus.workspace', detail })
  }

  const plan: Plan = {
    version: 1,
    id: PROBE_PLAN_ID,
    reason: 'installation acceptance: capability probe',
    summary: tr(input.lang ?? 'zh', '测量指针、键盘、窗口状态与工作区的控制能力',
      'measure pointer, keyboard, window state and workspace control'),
    workspace: null,
    budgetMs: PROBE_PLAN_BUDGET_MS,
    settleMs: 1_000,
    interferencePromptMs: 12_000,
    steps,
  }
  return { plan, checks, moveTarget, resizeTarget, limitations }
}
