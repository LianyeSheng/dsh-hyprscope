/**
 * Plan executor: `preflight -> commit -> verify` per step.
 *
 * The executor never reasons. A step either holds its declared premises, or the
 * run stops: restorable premises are handed to the caller as a suspension so a
 * derived recovery plan can be executed, and everything else becomes a fault
 * record. Postconditions are never recovered — a failed expectation means the
 * application did not behave as the plan assumed, and only the requester can
 * reason about that.
 *
 * The internal measurement mode (`options.measure`, used by the capability
 * probe) is the one exception: a failed step is recorded and the run continues,
 * so every capability gets a chance to be measured; only a lost lease, the plan
 * budget, or a foreign desktop change still stops it.
 */
import type { CapabilityId } from '../compat/types.ts'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import type { Client } from '../types.ts'
import type { DispatchRequest } from '../control/dispatch.ts'
import type { InjectCommand } from '../inject/injector.ts'
import type { PlanGrant } from './leasegate.ts'
import {
  OP_SPECS, PLAN_LIMITS, PREDICATE_SPECS,
  type Plan, type PlanStep, type Predicate, type PredicateKind, type StepOp, type WindowTarget,
} from './model.ts'
import { restorability, type Violation } from './recover.ts'
import type { RunStore } from './runstore.ts'
import { activeWorkspaceName, anchorPoint, anchorRegion, matchTarget, resolvePoint, type Snapshot } from './targets.ts'
import { STATE_CHANGING_EVENTS, type TapEvent } from './tap.ts'
import type { World } from './world.ts'

export type { Violation } from './recover.ts'

/** External events that always end the run when no premise accounted for them. */
const HARD_FATAL_EVENTS: readonly string[] = [
  'openwindow', 'closewindow', 'monitoradded', 'monitorremoved', 'monitorlayout', 'submap',
]

/**
 * Violations that still end a measured run: the desktop or the lease is no
 * longer trustworthy, so continuing would measure something meaningless.
 */
const MEASURE_SAFETY_STOPS: ReadonlySet<Violation['kind']> = new Set(['time.budget', 'foreign-event', 'lease.valid'])

/** Outcome of one step. */
export type StepOutcome = 'committed' | 'skipped' | 'failed' | 'revoked'

/** Recorded result of one step. */
export interface StepRecord {
  step: number
  op: StepOp
  outcome: StepOutcome
  startedAt: string
  durationMs: number
  effect: string | null
  screenshot: string | null
  violation: Violation | null
}

/** How far a step got before it stopped, in measure mode. */
export type MeasureStage = 'done' | 'preflight' | 'commit' | 'expect' | 'error'

/** One step's outcome in measure mode, for the capability probe. */
export interface MeasureStepFact {
  /** 0-based step index. */
  step: number
  op: StepOp
  /** ISO 8601 start time of the step. */
  at: string
  stage: MeasureStage
  /** Effect description when the mutating part ran. */
  effect: string | null
  /** The violation that failed the step, or null. */
  violation: { kind: string; detail: string; expected: unknown; observed: unknown } | null
  durationMs: number
}

/** Structured fault handed back to the caller. */
export interface FaultRecord {
  runId: string
  status: 'faulted' | 'revoked'
  step: number
  broken: {
    kind: string
    detail: string
    expected: unknown
    observed: unknown
    detectedAt: string
  }
  committed: number[]
  lastConfirmedEffect: string | null
  screenshot: string | null
  timeline: string
}

/** One screenshot taken during the run. */
export interface ScreenshotRecord {
  label: string
  step: number | null
  path: string
  sha256: string
}

/** Overall run result. */
export interface RunResult {
  runId: string
  status: 'completed' | 'faulted' | 'revoked'
  steps: StepRecord[]
  fault: FaultRecord | null
  screenshots: ScreenshotRecord[]
  startedAt: string
  finishedAt: string
  durationMs: number
  dir: string
}

/** Record of a run that stopped to recover its premises. */
export interface SuspendRecord {
  runId: string
  dir: string
  timeline: string
  /** Step that was interrupted. */
  step: number
  total: number
  broken: Violation[]
  committed: number[]
  lastConfirmedEffect: string | null
  steps: StepRecord[]
  screenshots: ScreenshotRecord[]
  /** Geometry observed before the attempt, keyed by window address. */
  baselineGeometry: Record<string, { x: number; y: number; width: number; height: number }>
  startedAt: string
  finishedAt: string
  durationMs: number
}

/** Result of executing one attempt. */
export type ExecutionOutcome =
  | { kind: 'done'; result: RunResult }
  | { kind: 'suspended'; record: SuspendRecord }

/** A restorable interference the host must decide about. */
export interface InterferenceRequest {
  /** 1-based step number the prompt belongs to. */
  step: number
  total: number
  /** Attempt the prompt belongs to (0 is the original plan). */
  attempt: number
  /** Recovery attempts the lease allows. */
  maxResumes: number
  /** Time budget the recovery attempt would get. */
  budgetMs: number
  /** Premises the recovery attempt would re-establish. */
  broken: { kind: string; detail: string; expected: unknown; observed: unknown }[]
  timeoutMs: number
}

/** One progress update reported to the overlay. */
export interface ProgressUpdate {
  step: number
  total: number
  op: StepOp
}

/** Inputs to {@link executePlan}. */
export interface ExecutorOptions {
  plan: Plan
  grant: PlanGrant
  world: World
  store: RunStore
  /** Re-read the lease; throws when control was revoked. */
  checkLease: () => Promise<void>
  /** Report step-level progress for the overlay. */
  onProgress?: (update: ProgressUpdate) => void | Promise<void>
  /**
   * Ask the human whether to recover after a restorable interference. Returning
   * `abort` ends the run; the callback owns the prompt UI and its timeout.
   */
  onInterference?: (request: InterferenceRequest) => Promise<'continue' | 'abort'>
  /**
   * Internal measurement mode used by the capability probe: a step that fails
   * is recorded and the run continues; only a lost lease, the plan budget, or a
   * foreign desktop change stops it. Never set from a plan document.
   */
  measure?: boolean
  /** Receives one fact per attempted step when `measure` is set. */
  onMeasureStep?: (fact: MeasureStepFact) => void
  /** Whether this attempt may suspend for recovery at all. */
  resumeAllowed: boolean
  /** Attempt index; 0 is the original plan, 1 the first recovery. */
  attempt: number
  /** Recovery attempts the consent covers. */
  maxResumes: number
  /** Budget a recovery attempt would get, shown in the prompt. */
  recoveryBudgetMs: number
  /** Capabilities the baseline grants; restore templates may only use these. */
  capabilities?: ReadonlySet<CapabilityId>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Mutable run state shared by the step helpers. */
interface Context {
  plan: Plan
  options: ExecutorOptions
  world: World
  store: RunStore
  checkLease: () => Promise<void>
  now: () => number
  sleep: (ms: number) => Promise<void>
  startedAt: number
  baseline: Snapshot
  baselineWorkspace: string | null
  baselineGeometry: Map<string, { x: number; y: number; width: number; height: number }>
  referenceHashes: Map<string, string>
  stepHashes: Map<string, string>
  screenshots: ScreenshotRecord[]
}

/** @param ms Delay in milliseconds. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * @param ms Epoch milliseconds.
 * @returns ISO-8601 timestamp.
 */
function iso(ms: number): string {
  return new Date(ms).toISOString()
}

/**
 * @param ctx Run context.
 * @returns Milliseconds since the run started.
 */
function elapsed(ctx: Context): number {
  return ctx.now() - ctx.startedAt
}

/**
 * Classify a failure as a revocation.
 * @param error Failure from the lease gate.
 * @returns Whether control was lost.
 */
function isRevocation(error: unknown): boolean {
  return error instanceof HyprscopeError
    && (error.code === ErrorCode.LEASE_MISMATCH || error.code === ErrorCode.NO_LEASE)
}

/**
 * Key identifying one anchored region across evaluations.
 * @param windowId Window address.
 * @param rect Unit rectangle.
 * @returns Stable map key.
 */
function regionKey(windowId: string, rect: readonly number[]): string {
  return `${windowId}:${rect.join(',')}`
}

/**
 * Build one violation for an unrecoverable observation problem.
 * @param kind Violation kind.
 * @param detail Reason.
 * @param extra Remaining fields.
 * @returns Violation marked non-restorable.
 */
function fatalViolation(
  kind: Violation['kind'],
  detail: string,
  extra: Partial<Pick<Violation, 'target' | 'expected' | 'observed' | 'predicate'>> = {},
): Violation {
  return { kind, detail, target: extra.target ?? null, expected: extra.expected ?? null, observed: extra.observed ?? null, restorable: false, predicate: extra.predicate }
}

/**
 * Resolve a window target, turning a miss into a violation.
 * @param target Selector.
 * @param snapshot Current snapshot.
 * @returns Client or violation.
 */
function resolveOrViolate(target: WindowTarget, snapshot: Snapshot): { client: Client } | { violation: Violation } {
  const match = matchTarget(target, snapshot.clients)
  if (match.kind === 'ok') return { client: match.client }
  if (match.kind === 'ambiguous') {
    return { violation: fatalViolation('target.ambiguous', 'target matches more than one window', { target, expected: 1, observed: match.matches.length }) }
  }
  return { violation: fatalViolation('target.missing', 'target window is not present', { target, expected: 'present', observed: 'absent' }) }
}

/**
 * Order predicates cheapest-first so a fatal failure stops before a capture.
 * @param predicates Predicates to order.
 * @returns Sorted copy.
 */
function orderPredicates(predicates: Predicate[]): Predicate[] {
  const cost = (kind: PredicateKind): number => {
    const spec = PREDICATE_SPECS[kind]
    return spec.cost === 'cached' ? 0 : spec.cost === 'state' ? 1 : spec.cost === 'pointer' ? 2 : 3
  }
  return [...predicates].sort((left, right) => cost(left.kind) - cost(right.kind))
}

/**
 * Capture an anchored region into the run directory.
 * @param ctx Run context.
 * @param window Client owning the region.
 * @param rect Unit rectangle.
 * @param label File label.
 * @param step Step index.
 * @returns SHA-256 of the captured PNG.
 */
async function captureRegion(
  ctx: Context,
  window: Client,
  rect: [number, number, number, number],
  label: string,
  step: number,
): Promise<string> {
  const region = anchorRegion(window, rect)
  const path = ctx.store.screenshotPath(label, step)
  const result = await ctx.world.capture({ output: path, region })
  return result.sha256
}

/**
 * Evaluate one precondition.
 * @param ctx Run context.
 * @param predicate Predicate to evaluate.
 * @param stepIndex Step index.
 * @param snapshot Snapshot shared by the whole evaluation pass.
 * @param cursor Pointer position, when needed.
 * @returns Violation or null.
 */
async function evaluateRequire(
  ctx: Context,
  predicate: Predicate,
  stepIndex: number,
  snapshot: Snapshot,
  cursor: { x: number; y: number } | null,
): Promise<Violation | null> {
  const baselineOf = (client: Client): { x: number; y: number; width: number; height: number } | null =>
    ctx.baselineGeometry.get(client.windowId) ?? null
  const restorable = (client: Client | null): boolean =>
    restorability({
      predicate,
      snapshot,
      cursor,
      baseline: client === null ? null : baselineOf(client),
      capabilities: ctx.options.capabilities,
    }).ok
  switch (predicate.kind) {
    case 'window.exists': {
      const resolved = resolveOrViolate(predicate.target!, snapshot)
      return 'violation' in resolved ? resolved.violation : null
    }
    case 'window.focused': {
      const resolved = resolveOrViolate(predicate.target!, snapshot)
      if ('violation' in resolved) return resolved.violation
      if (snapshot.activeWindow?.windowId === resolved.client.windowId) return null
      return {
        kind: 'window.focused', detail: 'the declared window does not hold focus', target: predicate.target!,
        expected: resolved.client.windowId, observed: snapshot.activeWindow?.windowId ?? null,
        restorable: restorable(resolved.client), predicate,
      }
    }
    case 'window.geometry': {
      const resolved = resolveOrViolate(predicate.target!, snapshot)
      if ('violation' in resolved) return resolved.violation
      const client = resolved.client
      const expected = predicate.x !== undefined
        ? { x: predicate.x, y: predicate.y!, width: predicate.width!, height: predicate.height! }
        : baselineOf(client)
      if (expected === null) {
        return fatalViolation('window.geometry', 'no baseline geometry for this window', {
          target: predicate.target!, expected: 'a baseline', observed: null, predicate,
        })
      }
      const tol = predicate.tol ?? 0
      const observed = { x: client.position.x, y: client.position.y, width: client.size.width, height: client.size.height }
      const drifted = Math.abs(observed.x - expected.x) > tol || Math.abs(observed.y - expected.y) > tol
        || Math.abs(observed.width - expected.width) > tol || Math.abs(observed.height - expected.height) > tol
      if (!drifted) return null
      return {
        kind: 'window.geometry', detail: 'window geometry changed beyond tolerance', target: predicate.target!,
        expected, observed, restorable: restorable(client), predicate,
      }
    }
    case 'window.state': {
      const resolved = resolveOrViolate(predicate.target!, snapshot)
      if ('violation' in resolved) return resolved.violation
      const client = resolved.client
      const observed: Record<string, boolean | number> = {
        floating: client.floating, pinned: client.pinned, fullscreen: client.fullscreen, fullscreenClient: client.fullscreenClient,
      }
      const expected: Record<string, boolean | number> = {}
      if (predicate.floating !== undefined) expected.floating = predicate.floating
      if (predicate.pinned !== undefined) expected.pinned = predicate.pinned
      if (predicate.fullscreen !== undefined) expected.fullscreen = predicate.fullscreen
      if (predicate.fullscreenClient !== undefined) expected.fullscreenClient = predicate.fullscreenClient
      const mismatch = Object.entries(expected).some(([key, value]) => observed[key] !== value)
      if (!mismatch) return null
      return {
        kind: 'window.state', detail: 'window state does not match', target: predicate.target!,
        expected, observed, restorable: restorable(client), predicate,
      }
    }
    case 'workspace.active': {
      const observed = activeWorkspaceName(snapshot.monitors)
      if (observed === predicate.name) return null
      return {
        kind: 'workspace.active', detail: 'a different workspace is active', target: null,
        expected: predicate.name, observed, restorable: restorable(null), predicate,
      }
    }
    case 'monitor.config': {
      const monitor = snapshot.monitors.find(entry => entry.name === predicate.name)
      if (monitor === undefined) {
        return fatalViolation('monitor.config', 'monitor is not present', { expected: predicate.name, observed: null, predicate })
      }
      const observed: Record<string, number> = { width: monitor.size.width, height: monitor.size.height, scale: monitor.scale }
      const expected: Record<string, number> = {}
      if (predicate.width !== undefined) expected.width = predicate.width
      if (predicate.height !== undefined) expected.height = predicate.height
      if (predicate.scale !== undefined) expected.scale = predicate.scale
      const mismatch = Object.entries(expected).some(([key, value]) => Math.abs(observed[key]! - value) > 0.001)
      if (!mismatch) return null
      return fatalViolation('monitor.config', 'monitor configuration changed', { expected, observed, predicate })
    }
    case 'clients.set': {
      const observed = snapshot.clients.map(client => client.windowId).sort()
      const expected = [...(predicate.ids ?? [])].sort()
      const same = observed.length === expected.length && observed.every((id, index) => id === expected[index])
      return same
        ? null
        : fatalViolation('clients.set', 'the set of open windows changed', { expected, observed, predicate })
    }
    case 'pointer.position': {
      let expected: { x: number; y: number } | null = null
      let expectedPoint: { x: number; y: number } | null = null
      if (predicate.target !== undefined) {
        const resolved = resolveOrViolate(predicate.target, snapshot)
        if ('violation' in resolved) return resolved.violation
        const anchor = anchorPoint(resolved.client, predicate.point!)
        expectedPoint = { x: anchor.x, y: anchor.y }
        expected = expectedPoint
      } else if (predicate.x !== undefined && predicate.y !== undefined) {
        expected = { x: predicate.x, y: predicate.y }
      }
      if (expected === null) {
        return fatalViolation('pointer.position', 'the pointer premise carries no position', { expected: null, observed: null, predicate })
      }
      if (cursor === null) {
        return fatalViolation('pointer.position', 'pointer position is unavailable', { expected, observed: null, predicate })
      }
      const tol = predicate.tol ?? 2
      if (Math.abs(cursor.x - expected.x) <= tol && Math.abs(cursor.y - expected.y) <= tol) return null
      return {
        kind: 'pointer.position', detail: 'pointer is not where the step expects it', target: predicate.target ?? null,
        expected, observed: cursor, restorable: restorable(null), predicate,
      }
    }
    case 'region.unchanged': {
      const resolved = resolveOrViolate(predicate.target!, snapshot)
      if ('violation' in resolved) return resolved.violation
      const key = regionKey(resolved.client.windowId, predicate.rect!)
      const hash = await captureRegion(ctx, resolved.client, predicate.rect!, `probe-${predicate.label ?? 'region'}`, stepIndex)
      const reference = ctx.referenceHashes.get(key)
      if (reference === undefined) {
        ctx.referenceHashes.set(key, hash)
        return null
      }
      return reference === hash
        ? null
        : fatalViolation('region.unchanged', 'captured region changed since the run started', {
            expected: reference, observed: hash, predicate,
          })
    }
    default:
      return null
  }
}

/**
 * Evaluate a step's preconditions.
 * @param ctx Run context.
 * @param predicates Declared requirements.
 * @param stepIndex Step index.
 * @returns Every broken premise.
 */
async function evaluateRequires(ctx: Context, predicates: Predicate[], stepIndex: number): Promise<Violation[]> {
  if (predicates.length === 0) return []
  const ordered = orderPredicates(predicates)
  const needsState = ordered.some(predicate => PREDICATE_SPECS[predicate.kind].cost === 'state'
    || PREDICATE_SPECS[predicate.kind].cost === 'capture')
  const needsPointer = ordered.some(predicate => predicate.kind === 'pointer.position')
  const snapshot = needsState ? await ctx.world.snapshot() : ctx.baseline
  const cursor = needsPointer ? await ctx.world.cursor() : null
  const violations: Violation[] = []
  for (const predicate of ordered) {
    const violation = await evaluateRequire(ctx, predicate, stepIndex, snapshot, cursor)
    if (violation !== null) violations.push(violation)
  }
  return violations
}

/**
 * Evaluate one expectation.
 * @param ctx Run context.
 * @param predicate Expectation to evaluate.
 * @param stepIndex Step index.
 * @param snapshot Snapshot shared by the pass.
 * @param cursor Pointer position when needed.
 * @returns Violation or null.
 */
async function evaluateExpectation(
  ctx: Context,
  predicate: Predicate,
  stepIndex: number,
  snapshot: Snapshot,
  cursor: { x: number; y: number } | null,
): Promise<Violation | null> {
  if (predicate.kind === 'region.changed') {
    const resolved = resolveOrViolate(predicate.target!, snapshot)
    if ('violation' in resolved) return resolved.violation
    const key = regionKey(resolved.client.windowId, predicate.rect!)
    const before = ctx.stepHashes.get(key)
    if (before === undefined) {
      return fatalViolation('postcondition', 'no pre-commit capture exists for region.changed', { expected: 'a pre-commit capture', observed: null })
    }
    const after = await captureRegion(ctx, resolved.client, predicate.rect!, 'verify', stepIndex)
    return after === before
      ? fatalViolation('region.changed', 'captured region did not change', { expected: `different than ${before}`, observed: after, predicate })
      : null
  }
  const violation = await evaluateRequire(ctx, predicate, stepIndex, snapshot, cursor)
  return violation === null ? null : { ...violation, restorable: false, predicate: violation.predicate ?? predicate }
}

/**
 * Evaluate a step's expectations.
 * @param ctx Run context.
 * @param predicates Declared expectations.
 * @param stepIndex Step index.
 * @returns Violations.
 */
async function evaluateExpectations(ctx: Context, predicates: Predicate[], stepIndex: number): Promise<Violation[]> {
  if (predicates.length === 0) return []
  const ordered = orderPredicates(predicates)
  const needsState = ordered.some(predicate => PREDICATE_SPECS[predicate.kind].cost !== 'capture')
  const needsPointer = ordered.some(predicate => predicate.kind === 'pointer.position')
  const snapshot = needsState ? await ctx.world.snapshot() : ctx.baseline
  const cursor = needsPointer ? await ctx.world.cursor() : null
  for (const predicate of ordered) {
    const violation = await evaluateExpectation(ctx, predicate, stepIndex, snapshot, cursor)
    if (violation !== null) return [violation]
  }
  return []
}

/**
 * Capture the "before" hashes required by `region.changed` expectations.
 * @param ctx Run context.
 * @param predicates Expectations of the step.
 * @param stepIndex Step index.
 * @param snapshot Pre-commit snapshot.
 */
async function primeExpectations(ctx: Context, predicates: Predicate[], stepIndex: number, snapshot: Snapshot): Promise<void> {
  ctx.stepHashes.clear()
  for (const predicate of predicates) {
    if (predicate.kind !== 'region.changed') continue
    const resolved = resolveOrViolate(predicate.target!, snapshot)
    if ('violation' in resolved) continue
    const key = regionKey(resolved.client.windowId, predicate.rect!)
    const hash = await captureRegion(ctx, resolved.client, predicate.rect!, 'before', stepIndex)
    ctx.stepHashes.set(key, hash)
  }
}

/**
 * Translate plan key names into the injector's vocabulary.
 * @param keys Plan key names.
 * @returns Injector key names.
 */
export function toInjectorKeys(keys: string[]): string[] {
  const modifiers: Record<string, string> = {
    ctrl: 'LEFTCTRL', control: 'LEFTCTRL', shift: 'LEFTSHIFT', alt: 'LEFTALT',
    super: 'LEFTMETA', meta: 'LEFTMETA', win: 'LEFTMETA',
  }
  const named: Record<string, string> = {
    escape: 'Escape', esc: 'Escape', return: 'Return', enter: 'Return', tab: 'Tab', space: 'space',
    backspace: 'Backspace', delete: 'Delete', home: 'Home', end: 'End', pageup: 'Page_Up',
    pagedown: 'Page_Down', up: 'Up', down: 'Down', left: 'Left', right: 'Right', insert: 'Insert',
  }
  return keys.map(key => {
    const lower = key.toLowerCase()
    if (modifiers[lower] !== undefined) return modifiers[lower]
    if (named[lower] !== undefined) return named[lower]
    if (/^f([1-9]|1[0-2])$/.test(lower)) return lower.toUpperCase()
    return key
  })
}

/**
 * Run the mutating part of one step.
 * @param ctx Run context.
 * @param step Step to apply.
 * @param snapshot Pre-commit snapshot.
 * @returns Human-readable effect description.
 */
async function commitStep(ctx: Context, step: PlanStep, snapshot: Snapshot): Promise<string> {
  switch (step.op) {
    case 'movePointer': {
      const point = resolvePoint(step.at!, snapshot.clients)
      if (point === null) throw new HyprscopeError(ErrorCode.FAULTED, 'anchor window disappeared before commit')
      await ctx.world.inject([{ op: 'move', x: point.x, y: point.y }])
      return `moved pointer to ${point.x},${point.y}`
    }
    case 'click': {
      const point = resolvePoint(step.at!, snapshot.clients)
      if (point === null) throw new HyprscopeError(ErrorCode.FAULTED, 'anchor window disappeared before commit')
      const button = step.button ?? 'left'
      const count = step.count ?? 1
      const commands: InjectCommand[] = [{ op: 'move', x: point.x, y: point.y }]
      for (let index = 0; index < count; index += 1) commands.push({ op: 'button', button, action: 'click' })
      await ctx.world.inject(commands)
      return `clicked ${button}${count > 1 ? ` x${count}` : ''} at ${point.x},${point.y}`
    }
    case 'scroll': {
      await ctx.world.inject([{ op: 'scroll', value: step.value!, axis: step.axis ?? 'vertical' }])
      return `scrolled ${step.axis ?? 'vertical'} by ${step.value!}`
    }
    case 'chord': {
      const keys = toInjectorKeys(step.keys!)
      await ctx.world.inject([{ op: 'chord', keys }])
      return `pressed ${keys.join('+')}`
    }
    case 'text': {
      await ctx.world.inject([{ op: 'text', text: step.text! }])
      return `typed ${step.text!.length} characters`
    }
    case 'focusWindow': {
      const resolved = resolveOrViolate(step.target!, snapshot)
      if ('violation' in resolved) throw new HyprscopeError(ErrorCode.FAULTED, resolved.violation.detail)
      await ctx.world.dispatch({ kind: 'focusWindow', windowId: resolved.client.windowId })
      return `focused ${resolved.client.windowId}`
    }
    case 'workspace': {
      const name = step.name!
      await ctx.world.dispatch({ kind: 'workspace', name })
      return `switched to workspace ${name}`
    }
    case 'moveWindow': {
      const resolved = resolveOrViolate(step.target!, snapshot)
      if ('violation' in resolved) throw new HyprscopeError(ErrorCode.FAULTED, resolved.violation.detail)
      await ctx.world.dispatch({ kind: 'moveWindow', windowId: resolved.client.windowId, x: step.x!, y: step.y! })
      return `moved ${resolved.client.windowId} to ${step.x!},${step.y!}`
    }
    case 'resizeWindow': {
      const resolved = resolveOrViolate(step.target!, snapshot)
      if ('violation' in resolved) throw new HyprscopeError(ErrorCode.FAULTED, resolved.violation.detail)
      await ctx.world.dispatch({ kind: 'resizeWindow', windowId: resolved.client.windowId, x: step.width!, y: step.height! })
      return `resized ${resolved.client.windowId} to ${step.width!}x${step.height!}`
    }
    case 'floatWindow': {
      const resolved = resolveOrViolate(step.target!, snapshot)
      if ('violation' in resolved) throw new HyprscopeError(ErrorCode.FAULTED, resolved.violation.detail)
      const client = resolved.client
      const applied: string[] = []
      if (step.floating !== undefined && client.floating !== step.floating) {
        await ctx.world.dispatch({ kind: 'floatWindow', windowId: client.windowId, floating: step.floating })
        applied.push(step.floating ? 'floating' : 'tiled')
      }
      if (step.pinned !== undefined && client.pinned !== step.pinned) {
        await ctx.world.dispatch({ kind: 'pinWindow', windowId: client.windowId, pinned: step.pinned })
        applied.push(step.pinned ? 'pinned' : 'unpinned')
      }
      return applied.length === 0 ? 'window state already matched' : `set ${applied.join(', ')}`
    }
    case 'fullscreenWindow': {
      const resolved = resolveOrViolate(step.target!, snapshot)
      if ('violation' in resolved) throw new HyprscopeError(ErrorCode.FAULTED, resolved.violation.detail)
      const internal = step.internal ?? 0
      const client = step.client ?? 0
      const current = resolved.client
      if (current.fullscreen === internal && current.fullscreenClient === client) return 'fullscreen state already matched'
      await ctx.world.dispatch({ kind: 'fullscreenWindow', windowId: current.windowId, internal, client })
      return `set fullscreen ${internal}/${client}`
    }
    default:
      throw new HyprscopeError(ErrorCode.FAULTED, `op ${step.op} does not commit`)
  }
}

/**
 * Run preflight for a step: lease, budget, external events, then declared premises.
 * @param ctx Run context.
 * @param step Step to check.
 * @param stepIndex Step index.
 * @param ambientMark Tap position after the previous step.
 * @returns Violations, recovery-blocking ones included.
 */
async function preflight(ctx: Context, step: PlanStep, stepIndex: number, ambientMark: number): Promise<Violation[]> {
  await ctx.checkLease()
  if (elapsed(ctx) > ctx.plan.budgetMs) {
    return [fatalViolation('time.budget', 'the plan ran past its time budget', {
      expected: `<= ${ctx.plan.budgetMs}ms`, observed: elapsed(ctx),
    })]
  }
  // Declared premises are the observed contract: if one broke, its kind decides
  // whether the tool can rebuild it. External events only add a hard stop when
  // they break something no premise accounted for.
  const declared = await evaluateRequires(ctx, step.requires ?? [], stepIndex)
  if (declared.length > 0) return declared
  const events: TapEvent[] = ctx.world.tap.since(ambientMark)
    .filter(event => !event.inCommit)
    .filter(event => STATE_CHANGING_EVENTS.includes(event.event))
  const fatal = events.filter(event => HARD_FATAL_EVENTS.includes(event.event))
  return fatal.map(event => fatalViolation('foreign-event', `external ${event.event} event`, {
    expected: 'no external change', observed: event.data,
  }))
}

/**
 * Execute a validated plan under an active grant.
 * @param options Plan, world, store, and lease gate.
 * @returns Completed/faulted result, or a suspension carrying the broken premises.
 */
export async function executePlan(options: ExecutorOptions): Promise<ExecutionOutcome> {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const plan = options.plan
  const world = options.world
  const store = options.store
  const startedAtMs = now()
  const measuring = options.measure === true
  await store.init(plan)
  await store.record({ at: iso(startedAtMs), kind: 'run.start', detail: { planId: plan.id, attempt: options.attempt } })

  const baseline = await world.snapshot()
  const baselineGeometry = new Map<string, { x: number; y: number; width: number; height: number }>()
  for (const client of baseline.clients) {
    baselineGeometry.set(client.windowId, {
      x: client.position.x, y: client.position.y, width: client.size.width, height: client.size.height,
    })
  }
  const ctx: Context = {
    plan,
    options,
    world,
    store,
    checkLease: async () => { await options.checkLease() },
    now,
    sleep,
    startedAt: startedAtMs,
    baseline,
    baselineWorkspace: activeWorkspaceName(baseline.monitors),
    baselineGeometry,
    referenceHashes: new Map(),
    stepHashes: new Map(),
    screenshots: [],
  }

  /**
   * First hard-fatal external event the run has not accounted for.
   * @returns Violation, or null.
   */
  const externalFatal = (): Violation | null => {
    const events = world.tap.since(ambientMark)
      .filter(event => !event.inCommit)
      .filter(event => HARD_FATAL_EVENTS.includes(event.event))
    const event = events[0]
    if (event === undefined) return null
    return fatalViolation('foreign-event', `external ${event.event} event`, {
      expected: 'no external change', observed: event.data,
    })
  }

  const steps: StepRecord[] = []
  const committed: number[] = []
  let lastConfirmedEffect: string | null = null
  // External events are considered from the moment the tap opened, so a change
  // that lands while the baseline snapshot is being read still counts.
  let ambientMark = 0

  /**
   * Deliver one step fact to the measurement hook. Non-measure runs never
   * report: the callback belongs to the capability probe's internal mode.
   * @param record Partial step record, duration already computed.
   * @param stage How far the step got.
   * @param violation Failure that stopped it, or null.
   */
  const reportFact = (record: StepRecord, stage: MeasureStage, violation: Violation | null): void => {
    if (!measuring) return
    options.onMeasureStep?.({
      step: record.step,
      op: record.op,
      at: record.startedAt,
      stage,
      effect: record.effect,
      violation: violation === null ? null : {
        kind: violation.kind,
        detail: violation.detail,
        expected: violation.expected,
        observed: violation.observed,
      },
      durationMs: record.durationMs,
    })
  }

  /**
   * Finish the run early with a fault record.
   * @param status Fault status.
   * @param stepIndex Step that failed.
   * @param broken Violation explaining the stop.
   * @returns Final result.
   */
  const fail = async (status: 'faulted' | 'revoked', stepIndex: number, broken: Violation): Promise<ExecutionOutcome> => {
    let screenshot: string | null = null
    try {
      const path = store.screenshotPath('fault', stepIndex >= 0 ? stepIndex : null)
      const capture = await world.capture({ output: path })
      screenshot = capture.path
      ctx.screenshots.push({ label: 'fault', step: stepIndex >= 0 ? stepIndex : null, path: capture.path, sha256: capture.sha256 })
    } catch {
      screenshot = null
    }
    const fault: FaultRecord = {
      runId: store.runId,
      status,
      step: stepIndex,
      broken: {
        kind: broken.kind,
        detail: broken.detail,
        expected: broken.expected,
        observed: broken.observed,
        detectedAt: iso(now()),
      },
      committed,
      lastConfirmedEffect,
      screenshot,
      timeline: store.timelinePath,
    }
    await store.record({ at: iso(now()), kind: 'run.fault', step: stepIndex, detail: { status, broken } })
    await store.writeJson('fault.json', fault)
    const finishedAt = now()
    const result: RunResult = {
      runId: store.runId, status, steps, fault, screenshots: ctx.screenshots,
      startedAt: iso(startedAtMs), finishedAt: iso(finishedAt), durationMs: finishedAt - startedAtMs, dir: store.dir,
    }
    await store.writeJson('result.json', result)
    return { kind: 'done', result }
  }

  /**
   * Record the failing step, then finish with a fault.
   * @param status Fault status.
   * @param stepIndex Step index.
   * @param record Partial step record.
   * @param violation Cause.
   * @param stage How far the step got before the stop.
   * @returns Final result.
   */
  const halt = async (
    status: 'faulted' | 'revoked',
    stepIndex: number,
    record: StepRecord,
    violation: Violation,
    stage: MeasureStage,
  ): Promise<ExecutionOutcome> => {
    record.outcome = status === 'revoked' ? 'revoked' : 'failed'
    record.violation = violation
    record.durationMs = now() - Date.parse(record.startedAt)
    reportFact(record, stage, violation)
    steps.push(record)
    return await fail(status, stepIndex, violation)
  }

  /**
   * Record one failed step in measure mode and let the run continue. Safety
   * violations never reach this helper: they still halt through {@link halt}.
   * @param record Partial step record.
   * @param violation Failure that stopped the step.
   * @param stage How far the step got.
   */
  const failStepInMeasure = async (record: StepRecord, violation: Violation, stage: MeasureStage): Promise<void> => {
    record.outcome = 'failed'
    record.violation = violation
    record.durationMs = now() - Date.parse(record.startedAt)
    reportFact(record, stage, violation)
    await store.record({ at: iso(now()), kind: 'step.measure-failed', step: record.step, detail: { stage, violation } })
    steps.push(record)
    // A failed step may leave events in the ambient window; they belong to the
    // attempt that just failed, not to the next step.
    ambientMark = world.tap.mark()
  }

  /**
   * Stop this attempt so the caller can derive a recovery plan.
   * @param stepIndex Interrupted step.
   * @param broken Broken premises.
   * @param record Partial step record.
   * @returns Suspension record.
   */
  const suspend = async (stepIndex: number, broken: Violation[], record: StepRecord): Promise<ExecutionOutcome> => {
    record.violation = broken[0] ?? null
    record.durationMs = now() - Date.parse(record.startedAt)
    steps.push(record)
    const finishedAt = now()
    const suspended: SuspendRecord = {
      runId: store.runId,
      dir: store.dir,
      timeline: store.timelinePath,
      step: stepIndex,
      total: plan.steps.length,
      broken,
      committed,
      lastConfirmedEffect,
      steps,
      screenshots: ctx.screenshots,
      baselineGeometry: Object.fromEntries(baselineGeometry),
      startedAt: iso(startedAtMs),
      finishedAt: iso(finishedAt),
      durationMs: finishedAt - startedAtMs,
    }
    await store.record({
      at: iso(finishedAt), kind: 'run.suspended', step: stepIndex,
      detail: { broken: broken.map(violation => ({ kind: violation.kind, detail: violation.detail })) },
    })
    await store.writeJson('suspended.json', suspended)
    return { kind: 'suspended', record: suspended }
  }

  try {
    for (const [index, step] of plan.steps.entries()) {
      const stepStart = now()
      // Set while the mutating call runs, so an exception thrown there is
      // classified as an op-level commit failure rather than an unexpected error.
      let commitAttempted = false
      const record: StepRecord = {
        step: index, op: step.op, outcome: 'skipped',
        startedAt: iso(stepStart), durationMs: 0, effect: null, screenshot: null, violation: null,
      }
      await store.record({ at: iso(stepStart), kind: 'step.start', step: index, detail: { op: step.op } })
      await options.onProgress?.({ step: index + 1, total: plan.steps.length, op: step.op })
      try {
        if (step.op === 'pause' || step.op === 'screenshot' || step.op === 'waitEvent') {
          // These ops never preflight, so a hard external event must be checked
          // here instead of being silently folded into the next ambient mark.
          const external = externalFatal()
          if (external !== null) return await halt('faulted', index, record, external, 'preflight')
        }
        if (step.op === 'pause') {
          await sleep(step.ms ?? 0)
          await store.record({ at: iso(now()), kind: 'step.pause', step: index, detail: { ms: step.ms } })
        } else if (step.op === 'waitEvent') {
          const mark = world.tap.mark()
          const event = await world.tap.waitFor([step.kind!], step.timeoutMs ?? PLAN_LIMITS.defaultWaitEventMs, mark)
          if (event === null) {
            const violation = fatalViolation('event.timeout', 'the expected event did not arrive', {
              expected: step.kind, observed: null,
            })
            if (measuring) {
              await failStepInMeasure(record, violation, 'commit')
              continue
            }
            return await halt('faulted', index, record, violation, 'commit')
          }
          record.effect = `observed ${event.event}`
          // Only the events up to and including the one that was waited for are
          // consumed; anything later (including hard external events) still counts.
          const pending = world.tap.since(mark)
          const offset = pending.indexOf(event)
          ambientMark = offset >= 0 ? mark + offset + 1 : world.tap.mark()
        } else if (step.op === 'screenshot') {
          const label = step.label ?? `shot-${index}`
          const snapshot = await world.snapshot()
          let region: { x: number; y: number; width: number; height: number } | undefined
          if (step.region !== undefined) {
            const resolved = resolveOrViolate(step.region.window, snapshot)
            if ('violation' in resolved) {
              if (measuring) {
                await failStepInMeasure(record, resolved.violation, 'commit')
                continue
              }
              return await halt('faulted', index, record, resolved.violation, 'commit')
            }
            region = anchorRegion(resolved.client, step.region.rect)
          }
          const path = store.screenshotPath(label, index)
          const capture = await world.capture({ output: path, region })
          record.screenshot = capture.path
          record.effect = `captured ${label} (${capture.width}x${capture.height})`
          ctx.screenshots.push({ label, step: index, path: capture.path, sha256: capture.sha256 })
          await store.record({ at: iso(now()), kind: 'step.capture', step: index, detail: { label, path: capture.path, sha256: capture.sha256 } })
        } else {
          const violations = await preflight(ctx, step, index, ambientMark)
          if (violations.length > 0) {
            ambientMark = world.tap.mark()
            const blocking = violations.find(violation => !violation.restorable)
            if (measuring) {
              // Measurement keeps going after a broken premise so the probe can
              // try every capability; only a safety violation stops the run.
              const safety = violations.find(violation => MEASURE_SAFETY_STOPS.has(violation.kind))
              if (safety !== undefined) return await halt('faulted', index, record, safety, 'preflight')
              await failStepInMeasure(record, blocking ?? violations[0]!, 'preflight')
              continue
            }
            if (blocking !== undefined) return await halt('faulted', index, record, blocking, 'preflight')
            if (!options.resumeAllowed) {
              const first = violations[0]!
              const reason = options.attempt === 0
                ? 'recovery is disabled for this run'
                : 'the recovery attempt may not recover again'
              return await halt('faulted', index, record, { ...first, detail: `${first.detail} (${reason})` }, 'preflight')
            }
            const decision = options.onInterference === undefined
              ? 'abort'
              : await options.onInterference({
                  step: index + 1,
                  total: plan.steps.length,
                  attempt: options.attempt,
                  maxResumes: options.maxResumes,
                  budgetMs: options.recoveryBudgetMs,
                  broken: violations.map(violation => ({
                    kind: violation.kind, detail: violation.detail,
                    expected: violation.expected, observed: violation.observed,
                  })),
                  timeoutMs: plan.interferencePromptMs,
                })
            await ctx.checkLease()
            if (decision === 'abort') {
              const first = violations[0]!
              return await halt('faulted', index, record, {
                ...first, detail: `${first.detail} (host chose to terminate)`,
              }, 'preflight')
            }
            await store.record({ at: iso(now()), kind: 'step.suspend', step: index, detail: { broken: violations.length } })
            return await suspend(index, violations, record)
          }
          ambientMark = world.tap.mark()
          if (step.op === 'assert') {
            record.effect = 'assertions held'
          } else {
            const snapshot = await world.snapshot()
            await primeExpectations(ctx, step.expect ?? [], index, snapshot)
            world.tap.beginCommit(plan.settleMs + 400)
            let committedEffect: string | null = null
            let expectedViolations: Violation[] = []
            let attempts = 0
            try {
              for (;;) {
                commitAttempted = true
                committedEffect = await commitStep(ctx, step, snapshot)
                commitAttempted = false
                await store.record({ at: iso(now()), kind: 'step.commit', step: index, detail: { effect: committedEffect } })
                const deadline = now() + plan.settleMs
                for (;;) {
                  expectedViolations = await evaluateExpectations(ctx, step.expect ?? [], index)
                  if (expectedViolations.length === 0) break
                  if (now() >= deadline) break
                  await sleep(Math.min(80, Math.max(10, deadline - now())))
                }
                if (expectedViolations.length === 0) break
                const retryAllowed = OP_SPECS[step.op].idempotent
                  && attempts < 1
                  && elapsed(ctx) + plan.settleMs < plan.budgetMs
                if (!retryAllowed) break
                attempts += 1
                await store.record({ at: iso(now()), kind: 'step.retry', step: index, detail: { attempt: attempts } })
              }
            } finally {
              world.tap.endCommit()
            }
            if (expectedViolations.length > 0) {
              const violation = expectedViolations[0]!
              await store.record({ at: iso(now()), kind: 'step.fault', step: index, detail: { violation } })
              if (measuring) {
                // The effect landed; only the read-back failed, so the record
                // keeps the commit's effect description.
                record.effect = committedEffect
                await failStepInMeasure(record, violation, 'expect')
                continue
              }
              return await halt('faulted', index, record, violation, 'expect')
            }
            record.effect = committedEffect
            record.outcome = 'committed'
            committed.push(index)
            lastConfirmedEffect = `step ${index} (${step.op}): ${committedEffect}`
            await store.record({ at: iso(now()), kind: 'step.ok', step: index, detail: { effect: committedEffect } })
            ambientMark = world.tap.mark()
          }
        }
      } catch (error) {
        if (isRevocation(error)) {
          const violation = fatalViolation('lease.valid', 'the lease was revoked while the plan was running', {
            expected: 'granted', observed: 'revoked',
          })
          // A revocation is a control-plane failure, and the step never gets past
          // its lease check; measure mode reports it as a preflight-stage fact.
          return await halt('revoked', index, record, violation, 'preflight')
        }
        const violation = fatalViolation('postcondition', error instanceof Error ? error.message : String(error), {
          expected: null, observed: null,
        })
        await store.record({ at: iso(now()), kind: 'step.error', step: index, detail: { message: violation.detail } })
        // An exception thrown by the mutating call is an op-level failure; one
        // thrown outside it is unexpected. Both are recorded in measure mode.
        const stage: MeasureStage = commitAttempted ? 'commit' : 'error'
        if (measuring) {
          await failStepInMeasure(record, violation, stage)
          continue
        }
        return await halt('faulted', index, record, violation, stage)
      }
      record.durationMs = now() - stepStart
      reportFact(record, 'done', null)
      steps.push(record)
    }
    const finishedAt = now()
    await store.record({ at: iso(finishedAt), kind: 'run.end', detail: { status: 'completed' } })
    const result: RunResult = {
      runId: store.runId, status: 'completed', steps, fault: null, screenshots: ctx.screenshots,
      startedAt: iso(startedAtMs), finishedAt: iso(finishedAt), durationMs: finishedAt - startedAtMs, dir: store.dir,
    }
    await store.writeJson('result.json', result)
    return { kind: 'done', result }
  } finally {
    await world.close()
  }
}
