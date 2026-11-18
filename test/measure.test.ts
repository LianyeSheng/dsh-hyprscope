/** Executor measurement mode: per-step facts, continuation, and safety stops. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { DispatchRequest } from '../src/control/dispatch.ts'
import { ErrorCode, HyprscopeError } from '../src/errors.ts'
import type { InjectCommand } from '../src/inject/injector.ts'
import {
  executePlan,
  type ExecutionOutcome,
  type ExecutorOptions,
  type InterferenceRequest,
  type MeasureStepFact,
  type ProgressUpdate,
  type RunResult,
} from '../src/plan/executor.ts'
import type { PlanGrant } from '../src/plan/leasegate.ts'
import type { Plan } from '../src/plan/model.ts'
import { RunStore } from '../src/plan/runstore.ts'
import type { Snapshot } from '../src/plan/targets.ts'
import { EventTap } from '../src/plan/tap.ts'
import { validatePlan } from '../src/plan/validate.ts'
import type { CaptureRequest, World } from '../src/plan/world.ts'
import type { CaptureResult } from '../src/screenshot.ts'
import type { Client, Monitor, Session } from '../src/types.ts'
import { fakeSession, removeDir, tempDir } from './support.ts'

/**
 * Build a client with deterministic geometry.
 * @param overrides Fields to replace.
 * @returns Client record.
 */
function client(overrides: Partial<Client> = {}): Client {
  return {
    windowId: '0x55a1',
    app: 'Alacritty',
    initialApp: 'Alacritty',
    title: 'terminal',
    pid: 4242,
    monitor: 0,
    workspace: { id: 1, name: 'agent' },
    position: { x: 100, y: 100 },
    size: { width: 800, height: 600 },
    floating: false,
    fullscreen: 0,
    fullscreenClient: 0,
    pinned: false,
    grouped: 0,
    mapped: true,
    hidden: false,
    acceptsInput: true,
    xwayland: false,
    focusHistoryId: 0,
    stableId: null,
    ...overrides,
  }
}

/**
 * Build a monitor record.
 * @param overrides Fields to replace.
 * @returns Monitor record.
 */
function monitor(overrides: Partial<Monitor> = {}): Monitor {
  return {
    id: 0,
    name: 'DP-1',
    description: 'test panel',
    position: { x: 0, y: 0 },
    size: { width: 2560, height: 1440 },
    scale: 1,
    transform: 0,
    refreshRate: 144,
    focused: true,
    dpmsOn: true,
    activeWorkspace: { id: 1, name: 'agent' },
    specialWorkspace: { id: 0, name: '' },
    reserved: [0, 0, 0, 0],
    ...overrides,
  }
}

/** World stub that records every mutation instead of touching a compositor. */
class FakeWorld implements World {
  readonly tap = new EventTap(fakeSession() as Session)
  clients: Client[]
  monitors: Monitor[]
  activeWindow: Client | null
  cursorPosition: { x: number; y: number } | null
  injected: InjectCommand[][] = []
  dispatched: DispatchRequest[] = []
  captures: CaptureRequest[] = []
  closed = false
  /** Workspace whose dispatch throws, as a compositor rejecting the request would. */
  rejectWorkspace: string | null = null

  /**
   * @param options Initial observable state.
   */
  constructor(options: { clients?: Client[]; activeWindow?: Client | null; cursor?: { x: number; y: number } } = {}) {
    this.clients = options.clients ?? [client()]
    const primary = this.clients[0]!
    this.monitors = [monitor({ activeWorkspace: primary.workspace })]
    this.activeWindow = options.activeWindow === undefined ? primary : options.activeWindow
    this.cursorPosition = options.cursor ?? { x: 0, y: 0 }
  }

  async snapshot(): Promise<Snapshot> {
    return { observedAt: Date.now(), clients: this.clients, monitors: this.monitors, activeWindow: this.activeWindow }
  }

  async cursor(): Promise<{ x: number; y: number } | null> {
    return this.cursorPosition
  }

  async dispatch(request: DispatchRequest): Promise<void> {
    this.dispatched.push(request)
    if (this.rejectWorkspace !== null && request.kind === 'workspace' && request.name === this.rejectWorkspace) {
      throw new HyprscopeError(ErrorCode.COMMAND_FAILED, `the compositor rejected workspace "${request.name}"`)
    }
  }

  async inject(commands: InjectCommand[]): Promise<void> {
    this.injected.push(commands)
  }

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    this.captures.push(request)
    return {
      path: request.output,
      bytes: 64,
      width: request.region?.width ?? 2560,
      height: request.region?.height ?? 1440,
      sha256: `hash-${this.captures.length}`,
      capturedAt: new Date().toISOString(),
      source: { monitor: null, region: request.region ?? null, scope: request.region === undefined ? 'layout' : 'region' },
    }
  }

  now(): number {
    return Date.now()
  }

  async close(): Promise<void> {
    this.closed = true
    this.tap.close()
  }
}

/**
 * Validate a plan literal into a plan.
 * @param steps Plan steps.
 * @param extra Top-level fields.
 * @returns Validated plan.
 */
function planOf(steps: unknown[], extra: Record<string, unknown> = {}): Plan {
  return validatePlan({ version: 1, reason: 'measure test plan', steps, ...extra })
}

/**
 * Build a plan-bound grant.
 * @returns Grant for one lease.
 */
function grantFor(): PlanGrant {
  return { leaseId: 'lease-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }
}

/**
 * Unwrap a finished execution.
 * @param outcome Outcome returned by the executor.
 * @returns The run result.
 */
function resultOf(outcome: ExecutionOutcome): RunResult {
  if (outcome.kind !== 'done') {
    assert.fail(`expected a finished run, got a suspension at step ${outcome.record.step}`)
  }
  return outcome.result
}

/** Overrides for {@link runPlan}. */
interface RunOverrides {
  /** Set false to run through the ordinary, non-measure path. */
  measure?: boolean
  checkLease?: () => Promise<void>
  onMeasureStep?: (fact: MeasureStepFact) => void
  onInterference?: (request: InterferenceRequest) => Promise<'continue' | 'abort'>
  now?: () => number
  onProgress?: (update: ProgressUpdate) => void | Promise<void>
}

/** Context captured around one measured execution. */
interface MeasuredRun {
  world: FakeWorld
  outcome: ExecutionOutcome
  facts: MeasureStepFact[]
  prompts: InterferenceRequest[]
}

/**
 * Execute a plan against a fake world with an isolated run store.
 * @param t Test context.
 * @param plan Validated plan.
 * @param world Fake world.
 * @param overrides Executor overrides.
 * @returns Fixture with the outcome and the reported measure facts.
 */
async function runPlan(
  t: import('node:test').TestContext,
  plan: Plan,
  world: FakeWorld,
  overrides: RunOverrides = {},
): Promise<MeasuredRun> {
  const root = tempDir('hyprscope-measure-')
  t.after(() => { removeDir(root) })
  const store = new RunStore({ root, runId: 'run-measure' })
  const facts: MeasureStepFact[] = []
  const prompts: InterferenceRequest[] = []
  const recordFact = (fact: MeasureStepFact): void => {
    facts.push(fact)
    overrides.onMeasureStep?.(fact)
  }
  const callback = overrides.onInterference
  const onInterference = async (request: InterferenceRequest): Promise<'continue' | 'abort'> => {
    prompts.push(request)
    return callback === undefined ? 'continue' : await callback(request)
  }
  const options: ExecutorOptions = {
    plan,
    grant: grantFor(),
    world,
    store,
    checkLease: overrides.checkLease ?? (async () => {}),
    resumeAllowed: true,
    attempt: 0,
    maxResumes: 1,
    recoveryBudgetMs: plan.budgetMs,
    onInterference,
    onMeasureStep: recordFact,
    onProgress: overrides.onProgress,
    sleep: async () => {},
  }
  if (overrides.measure !== false) options.measure = true
  if (overrides.now !== undefined) options.now = overrides.now
  const outcome = await executePlan(options)
  return { world, outcome, facts, prompts }
}

test('measure mode records a rejected dispatch and continues', async (t) => {
  const plan = planOf([
    { op: 'workspace', name: 'agent' },
    { op: 'workspace', name: 'two' },
  ])
  const world = new FakeWorld()
  world.rejectWorkspace = 'agent'
  const { outcome, facts } = await runPlan(t, plan, world)
  const result = resultOf(outcome)
  assert.equal(result.status, 'completed')
  assert.equal(facts.length, 2)
  assert.equal(facts[0]?.step, 0)
  assert.equal(facts[0]?.op, 'workspace')
  assert.equal(facts[0]?.stage, 'commit')
  assert.equal(facts[0]?.violation?.kind, 'postcondition')
  assert.match(facts[0]?.violation?.detail ?? '', /rejected workspace "agent"/)
  assert.equal(typeof facts[0]?.durationMs, 'number')
  // The fact carries the same start time the step record does.
  assert.equal(facts[0]?.at, result.steps[0]?.startedAt)
  assert.equal(facts[1]?.stage, 'done')
  assert.equal(facts[1]?.step, 1)
  assert.deepEqual(result.steps.map(step => step.outcome), ['failed', 'committed'])
  assert.equal(result.steps[0]?.violation?.kind, 'postcondition')
  assert.deepEqual(world.dispatched.map(request => request.kind), ['workspace', 'workspace'])
})

test('measure mode records a broken declared premise and continues', async (t) => {
  const plan = planOf([
    {
      op: 'focusWindow',
      target: { id: '0xdead' },
      requires: [{ kind: 'window.exists', target: { id: '0xdead' } }],
    },
    { op: 'workspace', name: 'agent' },
  ])
  const { outcome, facts } = await runPlan(t, plan, new FakeWorld())
  const result = resultOf(outcome)
  assert.equal(result.status, 'completed')
  assert.equal(facts.length, 2)
  assert.equal(facts[0]?.stage, 'preflight')
  assert.equal(facts[0]?.effect, null)
  assert.equal(facts[0]?.violation?.kind, 'target.missing')
  assert.equal(result.steps[0]?.outcome, 'failed')
  assert.equal(result.steps[1]?.outcome, 'committed')
  assert.equal(facts[1]?.stage, 'done')
})

test('measure mode records a restorable premise failure without prompting', async (t) => {
  const plan = planOf([
    {
      op: 'movePointer',
      at: { window: { id: '0x55a1' }, point: [0.42, 0.68] },
      requires: [{ kind: 'pointer.position', x: 436, y: 508, tol: 2 }],
    },
    { op: 'assert' },
  ], { workspace: 'agent' })
  const world = new FakeWorld({ cursor: { x: 0, y: 0 } })
  const { outcome, facts, prompts } = await runPlan(t, plan, world)
  const result = resultOf(outcome)
  assert.equal(result.status, 'completed')
  assert.equal(prompts.length, 0, 'measure mode must never suspend for recovery')
  assert.equal(facts[0]?.stage, 'preflight')
  assert.equal(facts[0]?.violation?.kind, 'pointer.position')
  assert.equal(result.steps[0]?.outcome, 'failed')
  assert.equal(facts[1]?.stage, 'done')
  assert.equal(result.steps[1]?.effect, 'assertions held')
  assert.equal(world.injected.length, 0)
  assert.equal(world.dispatched.length, 0)
})

test('measure mode records a failed expectation and keeps the commit effect', async (t) => {
  const plan = planOf([
    {
      op: 'focusWindow',
      target: { id: '0x55a1' },
      requires: [{ kind: 'window.exists', target: { id: '0x55a1' } }],
      expect: [{ kind: 'window.focused', target: { id: '0x55a1' } }],
    },
    { op: 'workspace', name: 'agent' },
  ], { settleMs: 50 })
  // The fake dispatch never moves focus, so the read-back after the commit fails.
  const world = new FakeWorld({ activeWindow: null })
  const { outcome, facts } = await runPlan(t, plan, world)
  const result = resultOf(outcome)
  assert.equal(result.status, 'completed')
  assert.equal(facts.length, 2)
  assert.equal(facts[0]?.stage, 'expect')
  assert.equal(facts[0]?.effect, 'focused 0x55a1')
  assert.equal(facts[0]?.violation?.kind, 'window.focused')
  assert.equal(result.steps[0]?.outcome, 'failed')
  assert.equal(result.steps[0]?.effect, 'focused 0x55a1')
  assert.equal(result.steps[1]?.outcome, 'committed')
  assert.equal(facts[1]?.stage, 'done')
})

test('measure mode reports a waitEvent timeout as a commit-stage failure', async (t) => {
  const plan = planOf([
    { op: 'waitEvent', kind: 'openwindow', timeoutMs: 100 },
    { op: 'workspace', name: 'agent' },
  ])
  const { outcome, facts } = await runPlan(t, plan, new FakeWorld())
  const result = resultOf(outcome)
  assert.equal(result.status, 'completed')
  assert.equal(facts.length, 2)
  assert.equal(facts[0]?.stage, 'commit')
  assert.equal(facts[0]?.violation?.kind, 'event.timeout')
  assert.equal(result.steps[0]?.outcome, 'failed')
  assert.equal(facts[1]?.stage, 'done')
})

test('measure mode still halts on a foreign desktop change', async (t) => {
  const plan = planOf([
    {
      op: 'focusWindow',
      target: { id: '0x55a1' },
      requires: [{ kind: 'window.exists', target: { id: '0x55a1' } }],
    },
  ])
  const world = new FakeWorld()
  world.tap.inject({ event: 'openwindow', data: '0xdead,Alacritty,ghost' })
  const { outcome, facts } = await runPlan(t, plan, world)
  const result = resultOf(outcome)
  assert.equal(result.status, 'faulted')
  assert.equal(result.fault?.broken.kind, 'foreign-event')
  assert.equal(facts.length, 1)
  assert.equal(facts[0]?.stage, 'preflight')
  assert.equal(facts[0]?.violation?.kind, 'foreign-event')
  assert.equal(result.steps[0]?.outcome, 'failed')
  assert.equal(world.dispatched.length, 0)
})

test('measure mode still halts when the lease is revoked', async (t) => {
  const plan = planOf([
    { op: 'workspace', name: 'agent' },
    { op: 'workspace', name: 'two' },
  ])
  let checks = 0
  const checkLease = async (): Promise<void> => {
    checks += 1
    if (checks > 1) throw new HyprscopeError(ErrorCode.LEASE_MISMATCH, 'Control was revoked')
  }
  const { outcome, facts } = await runPlan(t, plan, new FakeWorld(), { checkLease })
  const result = resultOf(outcome)
  assert.equal(checks, 2)
  assert.equal(result.status, 'revoked')
  assert.equal(result.fault?.broken.kind, 'lease.valid')
  assert.equal(facts.length, 2)
  assert.equal(facts[0]?.stage, 'done')
  assert.equal(facts[1]?.stage, 'preflight')
  assert.equal(result.steps[1]?.outcome, 'revoked')
})

test('measure mode still halts when the plan budget runs out', async (t) => {
  const plan = planOf([
    { op: 'workspace', name: 'agent' },
    { op: 'workspace', name: 'two' },
  ], { budgetMs: 500 })
  let clock = 0
  const { outcome, facts } = await runPlan(t, plan, new FakeWorld(), {
    now: () => clock,
    onProgress: update => { if (update.step === 2) clock += 1_000 },
  })
  const result = resultOf(outcome)
  assert.equal(result.status, 'faulted')
  assert.equal(result.fault?.broken.kind, 'time.budget')
  assert.deepEqual(result.fault?.committed, [0])
  assert.equal(facts.length, 2)
  assert.equal(facts[0]?.stage, 'done')
  assert.equal(facts[1]?.stage, 'preflight')
  assert.equal(facts[1]?.violation?.kind, 'time.budget')
  assert.equal(result.steps[1]?.outcome, 'failed')
})

test('without measure a failing dispatch still faults and never reports a fact', async (t) => {
  const plan = planOf([{ op: 'workspace', name: 'agent' }])
  const world = new FakeWorld()
  world.rejectWorkspace = 'agent'
  const reported: MeasureStepFact[] = []
  const { outcome } = await runPlan(t, plan, world, {
    measure: false,
    onMeasureStep: fact => { reported.push(fact) },
  })
  const result = resultOf(outcome)
  assert.equal(result.status, 'faulted')
  assert.equal(result.fault?.broken.kind, 'postcondition')
  assert.equal(result.steps[0]?.outcome, 'failed')
  assert.equal(reported.length, 0)
  assert.deepEqual(world.dispatched, [{ kind: 'workspace', name: 'agent' }])
})
