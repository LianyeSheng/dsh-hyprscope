/**
 * Recovery: turn broken premises into a resume plan.
 *
 * The rule this module encodes is deliberately narrow: a premise may be
 * re-established only when the tool can observe it and reach it with its own
 * dispatch subset. A closed window, a changed application surface, or a monitor
 * reconfiguration is *not* recoverable — those end the run and hand the facts
 * back to the requester, which is the only party that can reason about
 * application state.
 *
 * Recovery reuses the normal execution path: the synthesizer emits ordinary
 * plan steps in a fixed outside-in order (workspace, window structure, geometry,
 * focus, pointer), and the runtime executes them as a derived plan with a fresh
 * time budget.
 */
import { RESTORE_CAPABILITIES } from '../compat/catalog.ts'
import type { CapabilityId } from '../compat/types.ts'
import { tr, type RenderLanguage } from '../i18n.ts'
import {
  PLAN_LIMITS, PREDICATE_SPECS,
  type AbsolutePoint, type AnchorPoint, type Plan, type PlanLineage, type PlanStep, type Predicate,
  type PredicateKind, type RestoreKind, type WindowTarget,
} from './model.ts'
import { activeWorkspaceName, matchTarget, type Snapshot } from './targets.ts'
import type { Client } from '../types.ts'

/** One broken assumption or failed expectation. */
export interface Violation {
  kind: PredicateKind | 'target.missing' | 'target.ambiguous' | 'postcondition' | 'foreign-event' | 'event.timeout'
  detail: string
  target: WindowTarget | null
  expected: unknown
  observed: unknown
  /** Predicate that produced this violation, when a declared premise did. */
  predicate?: Predicate
  /** Whether the tool can re-establish this premise without help. */
  restorable: boolean
}

/** Window geometry observed at some point in the run. */
export interface Geometry {
  x: number
  y: number
  width: number
  height: number
}

/** Inputs to {@link restorability}. */
export interface RestorabilityInput {
  predicate: Predicate
  snapshot: Snapshot
  cursor: { x: number; y: number } | null
  /** Geometry captured before the run, used when the predicate omits pixels. */
  baseline: Geometry | null
  /**
   * Capabilities the baseline grants. When present, the restore template may
   * only use capabilities from this set; when absent, the verdict does not
   * consult the baseline at all.
   */
  capabilities?: ReadonlySet<CapabilityId>
}

/** Verdict for one broken premise. */
export type Restorability =
  | { ok: true; restore: RestoreKind }
  | { ok: false; reason: string }

/**
 * Decide whether one broken premise can be re-established by the tool.
 * @param input Predicate, live snapshot, pointer, and baseline geometry.
 * @returns Restore template, or the reason the premise is final.
 */
export function restorability(input: RestorabilityInput): Restorability {
  const spec = PREDICATE_SPECS[input.predicate.kind]
  if (!spec.restorable || spec.restore === null) {
    return { ok: false, reason: `a "${input.predicate.kind}" premise cannot be re-established by the tool` }
  }
  const restore = spec.restore
  const capabilities = input.capabilities
  if (capabilities !== undefined) {
    const missing = RESTORE_CAPABILITIES[restore].find(id => !capabilities.has(id))
    if (missing !== undefined) {
      return {
        ok: false,
        reason: `the "${restore}" restore template needs capability "${missing}", which the baseline does not support`,
      }
    }
  }
  const target = input.predicate.target
  let client: Client | null = null
  if (target !== undefined) {
    const match = matchTarget(target, input.snapshot.clients)
    if (match.kind === 'ambiguous') {
      return { ok: false, reason: `the target window of "${input.predicate.kind}" is ambiguous (more than one match)` }
    }
    if (match.kind !== 'ok') return { ok: false, reason: `the target window of "${input.predicate.kind}" is not present` }
    client = match.client
  }
  switch (spec.restore) {
    case 'workspace': {
      if (input.predicate.name === undefined) return { ok: false, reason: 'the workspace premise names no workspace' }
      return { ok: true, restore: 'workspace' }
    }
    case 'state':
      return client === null ? { ok: false, reason: 'the window state premise names no window' } : { ok: true, restore: 'state' }
    case 'geometry': {
      if (client === null) return { ok: false, reason: 'the geometry premise names no window' }
      if (!client.floating) {
        return { ok: false, reason: 'the window is tiled, so its geometry belongs to the layout' }
      }
      const explicit = input.predicate.x !== undefined
      if (!explicit && input.baseline === null) {
        return { ok: false, reason: 'no baseline geometry was observed for this window' }
      }
      return { ok: true, restore: 'geometry' }
    }
    case 'focus':
      return client === null ? { ok: false, reason: 'the focus premise names no window' } : { ok: true, restore: 'focus' }
    case 'pointer': {
      if (input.predicate.target !== undefined) {
        if (input.predicate.point === undefined) {
          return { ok: false, reason: 'a window-relative pointer premise needs a point' }
        }
        return client === null ? { ok: false, reason: 'the pointer anchor window is not present' } : { ok: true, restore: 'pointer' }
      }
      if (input.predicate.x === undefined || input.predicate.y === undefined) {
        return { ok: false, reason: 'the pointer premise carries no position' }
      }
      return { ok: true, restore: 'pointer' }
    }
    default:
      return { ok: false, reason: `unknown restore template for "${input.predicate.kind}"` }
  }
}

/**
 * Human-readable label for one restore template.
 * @param kind Restore template.
 * @param lang Render language; defaults to Chinese.
 * @returns Short label used in plan summaries.
 */
export function restoreLabel(kind: RestoreKind, lang: RenderLanguage = 'zh'): string {
  switch (kind) {
    case 'workspace': return tr(lang, '工作区', 'workspace')
    case 'state': return tr(lang, '窗口状态', 'window state')
    case 'geometry': return tr(lang, '窗口几何', 'window geometry')
    case 'focus': return tr(lang, '焦点', 'focus')
    case 'pointer': return tr(lang, '指针', 'pointer')
  }
}

/** Inputs to {@link synthesizeRestoreSteps}. */
export interface SynthesizeOptions {
  plan: Plan
  /** Index of the step that was interrupted. */
  stepIndex: number
  broken: Violation[]
  snapshot: Snapshot
  cursor: { x: number; y: number } | null
  baselineGeometry: Map<string, Geometry>
  /** Language of the plan summary; defaults to Chinese. */
  lang?: RenderLanguage
}

/** Steps that would restore the broken premises. */
export interface SynthesizedRestore {
  ok: true
  steps: PlanStep[]
  /** Premise kinds the plan restores, in execution order. */
  restored: PredicateKind[]
  summary: string
}

/** A premise the tool refuses to recover. */
export interface RestoreRefusal {
  ok: false
  kind: string
  reason: string
}

/** Outcome of synthesis. */
export type SynthesizeOutcome = SynthesizedRestore | RestoreRefusal

/** State wanted for one window, merged across broken premises. */
interface WantedState {
  target: WindowTarget
  client: Client
  floating?: boolean
  pinned?: boolean
  internal?: 0 | 1 | 2
  clientMode?: 0 | 1 | 2
}

/** Geometry wanted for one window. */
interface WantedGeometry {
  target: WindowTarget
  client: Client
  rect: Geometry
}

/**
 * Convert broken premises into ordinary plan steps, ordered outside-in.
 *
 * The order is the dependency order the compositor imposes: switching workspaces
 * can move focus, changing floating/fullscreen state blocks exact geometry, a
 * resize can drop focus, and focusing a window warps the pointer. Restoring a
 * later layer therefore never invalids an earlier one.
 * @param options Interrupted plan, broken premises, and live observation.
 * @returns Steps to prepend to the remaining plan, or a refusal.
 */
export function synthesizeRestoreSteps(options: SynthesizeOptions): SynthesizeOutcome {
  const states = new Map<string, WantedState>()
  const geometries = new Map<string, WantedGeometry>()
  const focuses = new Map<string, WindowTarget>()
  const pointers = new Map<string, AnchorPoint | AbsolutePoint>()
  const workspaces: string[] = []
  const restored: PredicateKind[] = []
  const refuse = (violation: Violation, reason: string): RestoreRefusal => ({
    ok: false, kind: violation.kind, reason,
  })

  for (const violation of options.broken) {
    const predicate = violation.predicate
    if (predicate === undefined) return refuse(violation, violation.detail)
    const target = predicate.target
    let client: Client | null = null
    if (target !== undefined) {
      const match = matchTarget(target, options.snapshot.clients)
      if (match.kind === 'ambiguous') {
        return refuse(violation, `the target window of "${predicate.kind}" is ambiguous (more than one match)`)
      }
      if (match.kind !== 'ok') return refuse(violation, `the target window of "${predicate.kind}" is not present`)
      client = match.client
    }
    const baseline = client === null ? null : options.baselineGeometry.get(client.windowId) ?? null
    const verdict = restorability({ predicate, snapshot: options.snapshot, cursor: options.cursor, baseline })
    if (!verdict.ok) return refuse(violation, verdict.reason)
    const restore = verdict.restore
    if (!restored.includes(predicate.kind)) restored.push(predicate.kind)

    if (restore === 'workspace') {
      const name = predicate.name
      if (name === undefined) return refuse(violation, 'the workspace premise names no workspace')
      if (!workspaces.includes(name)) workspaces.push(name)
      continue
    }
    // Every other template needs a resolved window. Targets are matched by id
    // when available, otherwise by app/title, exactly like the executor does.
    if (target === undefined || client === null) return refuse(violation, `the "${predicate.kind}" premise names no window`)
    if (restore === 'state') {
      const key = client.windowId
      const wanted = states.get(key) ?? { target, client }
      if (predicate.floating !== undefined) wanted.floating = predicate.floating
      if (predicate.pinned !== undefined) wanted.pinned = predicate.pinned
      if (predicate.fullscreen !== undefined) wanted.internal = predicate.fullscreen
      if (predicate.fullscreenClient !== undefined) wanted.clientMode = predicate.fullscreenClient
      states.set(key, wanted)
      continue
    }
    if (restore === 'geometry') {
      const rect: Geometry = predicate.x !== undefined
        ? { x: predicate.x, y: predicate.y!, width: predicate.width!, height: predicate.height! }
        : baseline ?? { x: -1, y: -1, width: 0, height: 0 }
      if (predicate.x === undefined && baseline === null) {
        return refuse(violation, 'no baseline geometry was observed for this window')
      }
      geometries.set(client.windowId, { target, client, rect })
      continue
    }
    if (restore === 'focus') {
      focuses.set(client.windowId, target)
      continue
    }
    if (restore === 'pointer') {
      const at: AnchorPoint | AbsolutePoint = predicate.target !== undefined
        ? { window: predicate.target, point: predicate.point! }
        : { x: predicate.x!, y: predicate.y! }
      pointers.set(JSON.stringify(at), at)
    }
  }

  const steps: PlanStep[] = []
  const exists = (target: WindowTarget): Predicate[] => [{ kind: 'window.exists', target }]
  for (const name of workspaces) steps.push({ op: 'workspace', name })
  // Structure first: a fullscreen window cannot be moved or resized, and a tiled
  // window's geometry is owned by the layout.
  for (const wanted of states.values()) {
    if (wanted.internal !== undefined || wanted.clientMode !== undefined) {
      steps.push({
        op: 'fullscreenWindow',
        target: wanted.target,
        internal: wanted.internal ?? (wanted.client.fullscreen as 0 | 1 | 2),
        client: wanted.clientMode ?? (wanted.client.fullscreenClient as 0 | 1 | 2),
        requires: exists(wanted.target),
      })
    }
    if (wanted.floating !== undefined || wanted.pinned !== undefined) {
      steps.push({
        op: 'floatWindow',
        target: wanted.target,
        ...(wanted.floating === undefined ? {} : { floating: wanted.floating }),
        ...(wanted.pinned === undefined ? {} : { pinned: wanted.pinned }),
        requires: exists(wanted.target),
      })
    }
  }
  for (const wanted of geometries.values()) {
    // Leaving fullscreen is a prerequisite of a free geometry even when the plan
    // never declared fullscreen: without it the move and resize are refused.
    const declared = states.get(wanted.client.windowId)
    if (wanted.client.fullscreen !== 0 || wanted.client.fullscreenClient !== 0) {
      if (declared?.internal === undefined && declared?.clientMode === undefined) {
        steps.push({
          op: 'fullscreenWindow', target: wanted.target, internal: 0, client: 0, requires: exists(wanted.target),
        })
      }
    }
    const floating: Predicate = { kind: 'window.state', target: wanted.target, floating: true }
    steps.push({
      op: 'moveWindow', target: wanted.target, x: wanted.rect.x, y: wanted.rect.y,
      requires: [...exists(wanted.target), floating],
    })
    steps.push({
      op: 'resizeWindow', target: wanted.target, width: wanted.rect.width, height: wanted.rect.height,
      requires: [...exists(wanted.target), floating],
    })
  }
  // A focus commit raises the window and warps the pointer, so it comes after
  // geometry and before the pointer.
  for (const target of focuses.values()) {
    steps.push({ op: 'focusWindow', target, requires: exists(target) })
  }
  for (const at of pointers.values()) steps.push({ op: 'movePointer', at })

  const budget = PLAN_LIMITS.maxSteps - (options.plan.steps.length - options.stepIndex)
  if (steps.length > budget) {
    return { ok: false, kind: 'recovery.too-many-steps', reason: `recovery needs ${steps.length} steps, budget is ${budget}` }
  }
  const lang: RenderLanguage = options.lang ?? 'zh'
  const labels = [...new Set(restored.map(kind => PREDICATE_SPECS[kind].restore))]
    .filter((kind): kind is RestoreKind => kind !== null)
    .map(kind => restoreLabel(kind, lang))
  const summary = tr(lang,
    `恢复${labels.join('、')}后继续第 ${options.stepIndex + 1}/${options.plan.steps.length} 步`,
    `restore ${labels.join(', ')} and continue at step ${options.stepIndex + 1}/${options.plan.steps.length}`)
  return { ok: true, steps, restored, summary }
}

/** Inputs to {@link deriveResumePlan}. */
export interface DeriveOptions {
  plan: Plan
  stepIndex: number
  attempt: number
  broken: Violation[]
  restoreSteps: PlanStep[]
  summary: string
}

/** Outcome of {@link deriveResumePlan}. */
export type DeriveOutcome =
  | { ok: true; plan: Plan }
  | { ok: false; reason: string }

/**
 * Build the derived plan for one recovery attempt.
 *
 * The derived plan carries the restore steps followed by the steps the original
 * run had not started. Its lineage records the root plan, the attempt number,
 * and the premises being recovered; the renewed lease covers the attempt the
 * executor is about to run.
 * @param options Original plan, interrupted step, and restore steps.
 * @returns Derived plan or the reason it cannot be built.
 */
export function deriveResumePlan(options: DeriveOptions): DeriveOutcome {
  const remaining = options.plan.steps.slice(options.stepIndex)
  if (options.restoreSteps.length + remaining.length === 0) {
    return { ok: false, reason: 'the interrupted plan has no remaining work' }
  }
  if (options.restoreSteps.length + remaining.length > PLAN_LIMITS.maxSteps) {
    return { ok: false, reason: 'the derived plan would exceed the step limit' }
  }
  const suffix = `-r${options.attempt}`
  const derivedId = `${options.plan.id.slice(0, Math.max(1, 64 - suffix.length))}${suffix}`
  const lineage: PlanLineage = {
    rootPlanId: options.plan.lineage?.rootPlanId ?? options.plan.id,
    attempt: options.attempt,
    interruptedAtStep: options.stepIndex,
    broken: [...new Set(options.broken.map(violation => violation.kind))],
  }
  return {
    ok: true,
    plan: {
      version: 1,
      id: derivedId,
      reason: `${options.plan.reason} (recovery ${options.attempt})`.slice(0, 200),
      summary: options.summary,
      budgetMs: options.plan.budgetMs,
      settleMs: options.plan.settleMs,
      interferencePromptMs: options.plan.interferencePromptMs,
      steps: [...options.restoreSteps, ...remaining],
      lineage,
      workspace: options.plan.workspace,
    },
  }
}

/**
 * Evaluate the workspace of a snapshot for a premise.
 * @param snapshot Current observation.
 * @returns Active workspace name, or null.
 */
export function snapshotWorkspace(snapshot: Snapshot): string | null {
  return activeWorkspaceName(snapshot.monitors)
}
