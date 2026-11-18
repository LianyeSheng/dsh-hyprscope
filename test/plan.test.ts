/** Plan validation, canonicalization, and the preflight/commit/verify executor. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { ErrorCode, HyprscopeError } from '../src/errors.ts'
import type { DispatchRequest } from '../src/control/dispatch.ts'
import { injectorArguments, type InjectCommand } from '../src/inject/injector.ts'
import {
  executePlan, toInjectorKeys,
  type ExecutionOutcome, type InterferenceRequest, type RunResult, type SuspendRecord,
} from '../src/plan/executor.ts'
import { canonicalJson } from '../src/plan/canonical.ts'
import type { PlanGrant } from '../src/plan/leasegate.ts'
import type { Plan } from '../src/plan/model.ts'
import { RunStore } from '../src/plan/runstore.ts'
import type { Snapshot } from '../src/plan/targets.ts'
import { EventTap } from '../src/plan/tap.ts'
import { PlanValidationError, summarizePlan, validatePlan } from '../src/plan/validate.ts'
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
  windowCaptures: { output: string; identifier: string }[] = []
  windowCaptureError: HyprscopeError | null = null
  hashes: string[] = []
  closed = false
  onInject: ((commands: InjectCommand[]) => void) | null = null

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
  }

  async inject(commands: InjectCommand[]): Promise<void> {
    this.injected.push(commands)
    this.onInject?.(commands)
  }

  async capture(request: CaptureRequest): Promise<CaptureResult> {
    this.captures.push(request)
    const sha256 = this.hashes.length > 0 ? this.hashes.shift()! : `hash-${this.captures.length}`
    return {
      path: request.output,
      bytes: 64,
      width: request.region?.width ?? 2560,
      height: request.region?.height ?? 1440,
      sha256,
      capturedAt: new Date().toISOString(),
      source: {
        monitor: null,
        region: request.region ?? null,
        scope: request.region === undefined ? 'layout' : 'region',
        window: null,
      },
    }
  }

  async captureWindow(request: { output: string; identifier: string }): Promise<CaptureResult> {
    this.windowCaptures.push(request)
    if (this.windowCaptureError !== null) throw this.windowCaptureError
    return {
      path: request.output,
      bytes: 64,
      width: 320,
      height: 200,
      sha256: `window-${this.windowCaptures.length}`,
      capturedAt: new Date().toISOString(),
      source: {
        monitor: null,
        region: null,
        scope: 'window',
        window: { identifier: request.identifier, appId: 'Alacritty', title: 'terminal' },
      },
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
  return validatePlan({ version: 1, reason: 'test plan', steps, ...extra })
}

/**
 * Build a plan-bound grant.
 * @param _plan Validated plan the grant covers.
 * @returns Grant for one lease.
 */
function grantFor(_plan: Plan): PlanGrant {
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

/**
 * Unwrap a suspended execution.
 * @param outcome Outcome returned by the executor.
 * @returns The suspension record.
 */
function suspensionOf(outcome: ExecutionOutcome): SuspendRecord {
  if (outcome.kind !== 'suspended') {
    assert.fail(`expected a suspension, got a ${outcome.kind} outcome`)
  }
  return outcome.record
}

/** Context captured around one execution. */
interface RunFixture {
  world: FakeWorld
  outcome: ExecutionOutcome
  prompts: InterferenceRequest[]
  dir: string
}

/** Overrides for {@link runPlan}. */
interface RunOverrides {
  checkLease?: () => Promise<void>
  onInterference?: ((request: InterferenceRequest) => Promise<'continue' | 'abort'>) | null
  resumeAllowed?: boolean
  attempt?: number
  maxResumes?: number
  recoveryBudgetMs?: number
}

/**
 * Execute a plan against a fake world with an isolated run store.
 * @param t Test context.
 * @param plan Validated plan.
 * @param world Fake world.
 * @param overrides Executor overrides.
 * @returns Fixture with the outcome and recorded interference prompts.
 */
async function runPlan(
  t: import('node:test').TestContext,
  plan: Plan,
  world: FakeWorld,
  overrides: RunOverrides = {},
): Promise<RunFixture> {
  const root = tempDir('hyprscope-runs-')
  t.after(() => { removeDir(root) })
  const store = new RunStore({ root, runId: 'run-test' })
  const prompts: InterferenceRequest[] = []
  const callback = overrides.onInterference
  const onInterference = callback === undefined
    ? async (request: InterferenceRequest): Promise<'continue'> => { prompts.push(request); return 'continue' }
    : callback === null
      ? undefined
      : async (request: InterferenceRequest): Promise<'continue' | 'abort'> => {
          prompts.push(request)
          return await callback(request)
        }
  const outcome = await executePlan({
    plan,
    grant: grantFor(plan),
    world,
    store,
    checkLease: overrides.checkLease ?? (async () => {}),
    onInterference,
    resumeAllowed: overrides.resumeAllowed ?? true,
    attempt: overrides.attempt ?? 0,
    maxResumes: overrides.maxResumes ?? 1,
    recoveryBudgetMs: overrides.recoveryBudgetMs ?? plan.budgetMs,
    sleep: async () => {},
  })
  return { world, outcome, prompts, dir: store.dir }
}

test('validatePlan applies defaults and summarizes ops', () => {
  const plan = validatePlan({ version: 1, reason: 'demo', steps: [{ op: 'workspace', name: 'agent' }] })
  assert.equal(plan.budgetMs, 8_000)
  assert.equal(plan.settleMs, 600)
  assert.equal(plan.interferencePromptMs, 12_000)
  assert.equal(plan.id, 'plan')
  const summary = summarizePlan(plan)
  assert.equal(summary.steps, 1)
  assert.deepEqual(summary.ops, ['workspace'])
  assert.equal(summary.workspace, null)
})

test('validatePlan rejects unsafe or underspecified steps', () => {
  const cases: { document: unknown; path: string }[] = [
    { document: { version: 1, reason: 'x', steps: [{ op: 'teleport' }] }, path: '$.steps[0].op' },
    { document: { version: 1, reason: 'x', steps: [{ op: 'click', at: { x: 1, y: 2 }, requires: [{ kind: 'window.exists', target: { id: '0x55a1' } }] }] }, path: '$.steps[0].expect' },
    { document: { version: 1, reason: 'x', steps: [{ op: 'focusWindow', target: { id: '0x55a1' } }] }, path: '$.steps[0].requires' },
    { document: { version: 1, reason: 'x', steps: [{ op: 'assert', requires: [{ kind: 'lease.valid' }] }] }, path: '$.steps[0].requires[0].kind' },
    { document: { version: 1, reason: 'x', steps: [{ op: 'assert', requires: [{ kind: 'region.changed', target: { id: '0x55a1' }, rect: [0, 0, 1, 1] }] }] }, path: '$.steps[0].requires[0]' },
    { document: { version: 1, reason: 'x', steps: [{ op: 'assert', requires: [{ kind: 'window.state', target: { id: '0x55a1' }, floating: true, extra: 1 }] }] }, path: '$.steps[0].requires[0].extra' },
    { document: { version: 1, reason: 'x', steps: [{ op: 'movePointer', at: { window: { id: '0x55a1' }, point: [2, 0] }, requires: [{ kind: 'window.exists', target: { id: '0x55a1' } }] }] }, path: '$.steps[0].at.point' },
    {
      document: {
        version: 1, reason: 'x',
        steps: [{
          op: 'screenshot',
          region: { window: { id: '0x55a1' }, rect: [0, 0, 1, 1] },
          window: { id: '0x55a1' },
        }],
      },
      path: '$.steps[0].window',
    },
  ]
  for (const entry of cases) {
    assert.throws(() => validatePlan(entry.document), (error: unknown) => {
      assert.ok(error instanceof PlanValidationError)
      assert.equal(error.code, ErrorCode.PLAN_INVALID)
      assert.ok(error.issues.some(issue => issue.path === entry.path), `expected issue at ${entry.path}, got ${JSON.stringify(error.issues)}`)
      return true
    })
  }
})

test('validatePlan accepts numeric fullscreen modes and rejects booleans or out-of-range modes', () => {
  for (const mode of [0, 1, 2] as const) {
    const plan = validatePlan({
      version: 1,
      reason: 'state modes',
      steps: [{
        op: 'assert',
        requires: [{ kind: 'window.state', target: { id: '0x55A1' }, fullscreen: mode, fullscreenClient: mode }],
      }],
    })
    const predicate = plan.steps[0]?.requires?.[0]
    assert.equal(predicate?.fullscreen, mode)
    assert.equal(predicate?.fullscreenClient, mode)
    assert.deepEqual(predicate?.target, { id: '0x55a1' })
  }
  for (const bad of [true, false, 3, -1, 1.5] as const) {
    assert.throws(() => validatePlan({
      version: 1,
      reason: 'state modes',
      steps: [{ op: 'assert', requires: [{ kind: 'window.state', target: { id: '0x55a1' }, fullscreen: bad }] }],
    }), (error: unknown) => {
      assert.ok(error instanceof PlanValidationError)
      assert.ok(error.issues.some(issue => issue.path === '$.steps[0].requires[0].fullscreen'))
      return true
    }, `expected fullscreen: ${String(bad)} to be rejected`)
  }
})

test('validatePlan accepts window-relative and absolute pointer premises but not a mix', () => {
  const anchored = validatePlan({
    version: 1,
    reason: 'pointer',
    steps: [{
      op: 'assert',
      requires: [{ kind: 'pointer.position', target: { app: 'Alacritty' }, point: [0.5, 0.5] }],
    }],
  })
  assert.deepEqual(anchored.steps[0]?.requires?.[0], {
    kind: 'pointer.position', target: { app: 'Alacritty' }, point: [0.5, 0.5], tol: 2,
  })
  const absolute = validatePlan({
    version: 1,
    reason: 'pointer',
    steps: [{ op: 'assert', requires: [{ kind: 'pointer.position', x: 10, y: 20, tol: 4 }] }],
  })
  assert.deepEqual(absolute.steps[0]?.requires?.[0], { kind: 'pointer.position', x: 10, y: 20, tol: 4 })
  assert.throws(() => validatePlan({
    version: 1,
    reason: 'pointer',
    steps: [{
      op: 'assert',
      requires: [{ kind: 'pointer.position', target: { app: 'Alacritty' }, point: [0.5, 0.5], x: 10, y: 20 }],
    }],
  }), (error: unknown) => {
    assert.ok(error instanceof PlanValidationError)
    assert.ok(error.issues.some(issue =>
      issue.path === '$.steps[0].requires[0]' && /cannot also carry absolute x\/y/.test(issue.message)))
    return true
  })
})

test('validatePlan checks the resizeWindow and fullscreenWindow schema', () => {
  const exists = [{ kind: 'window.exists', target: { id: '0x55a1' } }]
  const plan = validatePlan({
    version: 1,
    reason: 'structural ops',
    steps: [
      { op: 'resizeWindow', target: { id: '0x55a1' }, width: 640, height: 480, requires: exists },
      { op: 'fullscreenWindow', target: { id: '0x55a1' }, requires: exists },
      { op: 'fullscreenWindow', target: { id: '0x55a1' }, internal: 2, client: 1, requires: exists },
    ],
  })
  assert.equal(plan.steps[0]?.width, 640)
  assert.equal(plan.steps[0]?.height, 480)
  // Omitting the modes means "not fullscreen"; the catalog default is explicit.
  assert.equal(plan.steps[1]?.internal, 0)
  assert.equal(plan.steps[1]?.client, 0)
  assert.equal(plan.steps[2]?.internal, 2)
  assert.equal(plan.steps[2]?.client, 1)
  const cases: { document: unknown; path: string }[] = [
    {
      document: {
        version: 1,
        reason: 'structural ops',
        steps: [{ op: 'resizeWindow', target: { id: '0x55a1' }, width: 640, requires: exists }],
      },
      path: '$.steps[0].height',
    },
    {
      document: {
        version: 1,
        reason: 'structural ops',
        steps: [{ op: 'resizeWindow', target: { id: '0x55a1' }, width: 0, height: 480, requires: exists }],
      },
      path: '$.steps[0].width',
    },
    {
      document: {
        version: 1,
        reason: 'structural ops',
        steps: [{ op: 'fullscreenWindow', target: { id: '0x55a1' }, internal: 3, requires: exists }],
      },
      path: '$.steps[0].internal',
    },
    {
      document: {
        version: 1,
        reason: 'structural ops',
        steps: [{ op: 'floatWindow', target: { id: '0x55a1' }, requires: exists }],
      },
      path: '$.steps[0]',
    },
  ]
  for (const entry of cases) {
    assert.throws(() => validatePlan(entry.document), (error: unknown) => {
      assert.ok(error instanceof PlanValidationError)
      assert.ok(error.issues.some(issue => issue.path === entry.path), `expected issue at ${entry.path}, got ${JSON.stringify(error.issues)}`)
      return true
    })
  }
})

test('authored plans may not carry a lineage; only derived plans may', () => {
  const lineage = {
    rootPlanId: 'root-plan',
    attempt: 1,
    interruptedAtStep: 0,
    broken: ['pointer.position'],
  }
  const document = { version: 1, id: 'smuggled', reason: 'carry a lineage', steps: [{ op: 'assert' }], lineage }
  assert.throws(() => validatePlan(document), (error: unknown) => {
    assert.ok(error instanceof PlanValidationError)
    assert.ok(error.issues.some(issue => issue.path === '$.lineage'))
    return true
  })
  const accepted = validatePlan(document, { allowLineage: true })
  assert.deepEqual(accepted.lineage, lineage)
  assert.throws(() => validatePlan({
    ...document,
    lineage: { ...lineage, attempt: 0 },
  }, { allowLineage: true }), (error: unknown) => {
    assert.ok(error instanceof PlanValidationError)
    assert.ok(error.issues.some(issue => issue.path === '$.lineage.attempt'))
    return true
  })
})

test('plan canonicalization is stable across key order', () => {
  const first = validatePlan({
    version: 1, reason: 'demo', steps: [
      { op: 'assert', requires: [{ kind: 'window.exists', target: { id: '0x55A1' } }] },
    ],
  })
  const second = validatePlan({
    reason: 'demo', version: 1, steps: [
      { requires: [{ target: { id: '0x55a1' }, kind: 'window.exists' }], op: 'assert' },
    ],
  })
  assert.equal(canonicalJson(first), canonicalJson(second))
})

test('executor completes a focus, move, and capture plan', async (t) => {
  const plan = planOf([
    { op: 'focusWindow', target: { id: '0x55a1' }, requires: [{ kind: 'window.exists', target: { id: '0x55a1' } }] },
    { op: 'movePointer', at: { window: { id: '0x55a1' }, point: [0.5, 0.5] }, requires: [{ kind: 'window.focused', target: { id: '0x55a1' } }] },
    { op: 'screenshot', label: 'after' },
  ])
  const { outcome, world, prompts } = await runPlan(t, plan, new FakeWorld())
  const result = resultOf(outcome)
  assert.equal(result.status, 'completed')
  assert.equal(result.steps.length, 3)
  assert.deepEqual(result.steps.map(step => step.outcome), ['committed', 'committed', 'skipped'])
  assert.equal(prompts.length, 0)
  assert.deepEqual(world.dispatched, [{ kind: 'focusWindow', windowId: '0x55a1' }])
  assert.deepEqual(world.injected, [[{ op: 'move', x: 500, y: 400 }]])
  assert.equal(result.screenshots.length, 1)
  const onDisk = JSON.parse(readFileSync(`${result.dir}/result.json`, 'utf8')) as { status: string }
  assert.equal(onDisk.status, 'completed')
  const approved = JSON.parse(readFileSync(`${result.dir}/plan.json`, 'utf8')) as { plan: { id: string } }
  assert.equal(approved.plan.id, plan.id)
})

test('executor applies the structural window dispatches', async (t) => {
  const exists = [{ kind: 'window.exists', target: { id: '0x55a1' } }]
  const plan = planOf([
    { op: 'floatWindow', target: { id: '0x55a1' }, floating: true, requires: exists },
    { op: 'resizeWindow', target: { id: '0x55a1' }, width: 640, height: 480, requires: exists },
    { op: 'fullscreenWindow', target: { id: '0x55a1' }, internal: 1, client: 2, requires: exists },
  ])
  const { outcome, world } = await runPlan(t, plan, new FakeWorld())
  const result = resultOf(outcome)
  assert.equal(result.status, 'completed')
  assert.deepEqual(world.dispatched, [
    { kind: 'floatWindow', windowId: '0x55a1', floating: true },
    { kind: 'resizeWindow', windowId: '0x55a1', x: 640, y: 480 },
    { kind: 'fullscreenWindow', windowId: '0x55a1', internal: 1, client: 2 },
  ])
  assert.deepEqual(world.injected, [])
  assert.deepEqual(result.steps.map(step => step.outcome), ['committed', 'committed', 'committed'])
  assert.equal(result.steps[0]?.effect, 'set floating')
  assert.equal(result.steps[1]?.effect, 'resized 0x55a1 to 640x480')
  assert.equal(result.steps[2]?.effect, 'set fullscreen 1/2')
})

test('executor faults when the target window is gone without prompting', async (t) => {
  const plan = planOf([
    { op: 'focusWindow', target: { app: 'Ghost' }, requires: [{ kind: 'window.exists', target: { app: 'Ghost' } }] },
  ])
  const world = new FakeWorld()
  const { outcome, prompts } = await runPlan(t, plan, world)
  const result = resultOf(outcome)
  assert.equal(result.status, 'faulted')
  assert.equal(result.fault?.broken.kind, 'target.missing')
  assert.deepEqual(result.fault?.committed, [])
  assert.equal(result.fault?.lastConfirmedEffect, null)
  assert.ok(result.fault?.screenshot !== null)
  assert.equal(prompts.length, 0)
  assert.deepEqual(world.injected, [])
  assert.deepEqual(world.dispatched, [])
})

test('executor faults immediately on other non-restorable premises', async (t) => {
  const cases: { requires: unknown[]; kind: string }[] = [
    { requires: [{ kind: 'clients.set', ids: ['0xdead'] }], kind: 'clients.set' },
    { requires: [{ kind: 'monitor.config', name: 'DP-1', width: 1920 }], kind: 'monitor.config' },
  ]
  for (const entry of cases) {
    const plan = planOf([{ op: 'assert', requires: entry.requires }])
    const { outcome, prompts } = await runPlan(t, plan, new FakeWorld())
    const result = resultOf(outcome)
    assert.equal(result.status, 'faulted', entry.kind)
    assert.equal(result.fault?.broken.kind, entry.kind)
    assert.equal(prompts.length, 0, `${entry.kind} must not prompt`)
  }
})

test('executor suspends on restorable pointer drift instead of injecting', async (t) => {
  const plan = planOf([
    {
      op: 'movePointer',
      at: { window: { id: '0x55a1' }, point: [0.42, 0.68] },
      requires: [{ kind: 'pointer.position', x: 436, y: 508, tol: 2 }],
    },
    { op: 'assert' },
  ], { workspace: 'agent' })
  const world = new FakeWorld({ cursor: { x: 0, y: 0 } })
  const { outcome, prompts } = await runPlan(t, plan, world, {
    attempt: 1,
    maxResumes: 2,
    recoveryBudgetMs: 4_321,
  })
  const record = suspensionOf(outcome)
  assert.equal(record.broken.length, 1)
  const broken = record.broken[0]!
  assert.equal(broken.kind, 'pointer.position')
  assert.equal(broken.restorable, true)
  assert.deepEqual(broken.expected, { x: 436, y: 508 })
  assert.deepEqual(broken.observed, { x: 0, y: 0 })
  assert.equal(record.step, 0)
  assert.equal(record.total, 2)
  assert.deepEqual(record.baselineGeometry['0x55a1'], { x: 100, y: 100, width: 800, height: 600 })
  assert.deepEqual(record.committed, [])
  assert.equal(record.lastConfirmedEffect, null)
  assert.equal(record.steps.length, 1)
  assert.equal(record.steps[0]?.violation?.kind, 'pointer.position')
  assert.equal(record.steps[0]?.outcome, 'skipped')
  // A suspension is observation only: nothing was dispatched and nothing injected.
  assert.equal(world.injected.length, 0)
  assert.equal(world.dispatched.length, 0)
  const onDisk = JSON.parse(readFileSync(`${record.dir}/suspended.json`, 'utf8')) as {
    step: number
    broken: { kind: string }[]
    baselineGeometry: Record<string, unknown>
  }
  assert.equal(onDisk.step, 0)
  assert.equal(onDisk.broken[0]?.kind, 'pointer.position')
  assert.deepEqual(onDisk.baselineGeometry['0x55a1'], { x: 100, y: 100, width: 800, height: 600 })
  // The prompt the host would answer carries the recovery facts.
  assert.equal(prompts.length, 1)
  const prompt = prompts[0]!
  assert.equal(prompt.step, 1)
  assert.equal(prompt.total, 2)
  assert.equal(prompt.attempt, 1)
  assert.equal(prompt.maxResumes, 2)
  assert.equal(prompt.budgetMs, 4_321)
  assert.equal(prompt.timeoutMs, plan.interferencePromptMs)
  assert.equal(prompt.broken.length, 1)
  assert.equal(prompt.broken[0]?.kind, 'pointer.position')
  assert.match(prompt.broken[0]?.detail ?? '', /pointer is not where the step expects it/)
  assert.deepEqual(prompt.broken[0]?.expected, { x: 436, y: 508 })
  assert.deepEqual(prompt.broken[0]?.observed, { x: 0, y: 0 })
})

test('executor faults when the host terminates the recovery prompt', async (t) => {
  const plan = planOf([
    {
      op: 'movePointer',
      at: { window: { id: '0x55a1' }, point: [0.42, 0.68] },
      requires: [{ kind: 'pointer.position', x: 436, y: 508, tol: 2 }],
    },
  ], { workspace: 'agent' })
  const world = new FakeWorld({ cursor: { x: 0, y: 0 } })
  const { outcome, prompts } = await runPlan(t, plan, world, { onInterference: async () => 'abort' })
  const result = resultOf(outcome)
  assert.equal(result.status, 'faulted')
  assert.equal(result.fault?.broken.kind, 'pointer.position')
  assert.match(result.fault?.broken.detail ?? '', /\(host chose to terminate\)$/)
  assert.deepEqual(result.fault?.committed, [])
  assert.equal(prompts.length, 1)
  assert.equal(world.injected.length, 0)
  assert.equal(world.dispatched.length, 0)
})

test('executor fails closed when no interference prompt is available', async (t) => {
  const plan = planOf([
    {
      op: 'movePointer',
      at: { window: { id: '0x55a1' }, point: [0.42, 0.68] },
      requires: [{ kind: 'pointer.position', x: 436, y: 508, tol: 2 }],
    },
  ], { workspace: 'agent' })
  const { outcome } = await runPlan(t, plan, new FakeWorld({ cursor: { x: 0, y: 0 } }), { onInterference: null })
  const result = resultOf(outcome)
  assert.equal(result.status, 'faulted')
  assert.match(result.fault?.broken.detail ?? '', /\(host chose to terminate\)$/)
})

test('a recovery attempt may not recover again', async (t) => {
  const plan = planOf([
    {
      op: 'movePointer',
      at: { window: { id: '0x55a1' }, point: [0.42, 0.68] },
      requires: [{ kind: 'pointer.position', x: 436, y: 508, tol: 2 }],
    },
  ], { workspace: 'agent' })
  const world = new FakeWorld({ cursor: { x: 0, y: 0 } })
  const { outcome, prompts } = await runPlan(t, plan, world, { resumeAllowed: false, attempt: 1, maxResumes: 1 })
  const result = resultOf(outcome)
  assert.equal(result.status, 'faulted')
  assert.equal(result.fault?.broken.kind, 'pointer.position')
  assert.match(result.fault?.broken.detail ?? '', /the recovery attempt may not recover again/)
  assert.equal(prompts.length, 0)
  assert.equal(world.injected.length, 0)
})

test('floating geometry drift suspends while tiled geometry drift faults', async (t) => {
  const requires = [{ kind: 'window.geometry', target: { id: '0x55a1' }, x: 5, y: 5, width: 800, height: 600 }]
  const plan = planOf([{ op: 'assert', requires }])

  const floatingWorld = new FakeWorld({ clients: [client({ floating: true })] })
  const suspended = suspensionOf((await runPlan(t, plan, floatingWorld)).outcome)
  assert.equal(suspended.broken[0]?.kind, 'window.geometry')
  assert.equal(suspended.broken[0]?.restorable, true)
  assert.equal(suspended.step, 0)
  assert.equal(floatingWorld.injected.length, 0)

  const tiledWorld = new FakeWorld({ clients: [client({ floating: false })] })
  const { outcome, prompts } = await runPlan(t, plan, tiledWorld)
  const result = resultOf(outcome)
  assert.equal(result.status, 'faulted')
  assert.equal(result.fault?.broken.kind, 'window.geometry')
  assert.equal(prompts.length, 0)
})

test('executor faults when the lease disappears', async (t) => {
  const plan = planOf([
    { op: 'focusWindow', target: { id: '0x55a1' }, requires: [{ kind: 'window.exists', target: { id: '0x55a1' } }] },
  ])
  const world = new FakeWorld()
  const { outcome } = await runPlan(t, plan, world, {
    checkLease: async () => { throw new HyprscopeError(ErrorCode.LEASE_MISMATCH, 'Control was revoked') },
  })
  const result = resultOf(outcome)
  assert.equal(result.status, 'revoked')
  assert.equal(result.fault?.status, 'revoked')
  assert.equal(result.fault?.broken.kind, 'lease.valid')
  assert.equal(world.injected.length, 0)
  assert.equal(world.dispatched.length, 0)
})

test('executor faults when a postcondition never holds, never suspends', async (t) => {
  const plan = planOf([
    {
      op: 'click',
      at: { x: 200, y: 200 },
      requires: [
        { kind: 'window.focused', target: { id: '0x55a1' } },
        { kind: 'window.geometry', target: { id: '0x55a1' } },
      ],
      expect: [{ kind: 'window.state', target: { id: '0x55a1' }, floating: true }],
    },
  ], { settleMs: 50 })
  const { outcome, world, prompts } = await runPlan(t, plan, new FakeWorld())
  const result = resultOf(outcome)
  assert.equal(result.status, 'faulted')
  assert.equal(result.fault?.broken.kind, 'window.state')
  assert.equal(result.fault?.step, 0)
  assert.equal(world.injected.length, 1)
  assert.equal(prompts.length, 0)
  assert.equal(result.fault?.committed.length, 0)
})

test('executor faults on a hard fatal foreign event', async (t) => {
  const plan = planOf([{ op: 'assert' }])
  const world = new FakeWorld()
  world.tap.inject({ event: 'openwindow', data: '0xdead,Alacritty,ghost' })
  const { outcome, prompts } = await runPlan(t, plan, world)
  const result = resultOf(outcome)
  assert.equal(result.status, 'faulted')
  assert.equal(result.fault?.broken.kind, 'foreign-event')
  assert.match(result.fault?.broken.detail ?? '', /external openwindow event/)
  assert.equal(prompts.length, 0)
  assert.equal(world.injected.length, 0)
})

test('a broken premise takes precedence over a hard fatal foreign event', async (t) => {
  const plan = planOf([
    {
      op: 'movePointer',
      at: { window: { id: '0x55a1' }, point: [0.42, 0.68] },
      requires: [{ kind: 'pointer.position', x: 436, y: 508, tol: 2 }],
    },
  ], { workspace: 'agent' })
  const world = new FakeWorld({ cursor: { x: 0, y: 0 } })
  world.tap.inject({ event: 'openwindow', data: '0xdead,Alacritty,ghost' })
  const { outcome } = await runPlan(t, plan, world)
  const record = suspensionOf(outcome)
  assert.equal(record.broken.length, 1)
  assert.equal(record.broken[0]?.kind, 'pointer.position')
  assert.equal(world.injected.length, 0)
})

test('foreign events outside the hard fatal list no longer create violations', async (t) => {
  const plan = planOf([{ op: 'assert' }])
  const world = new FakeWorld()
  world.tap.inject({ event: 'workspace', data: '2' })
  const { outcome, prompts } = await runPlan(t, plan, world)
  const result = resultOf(outcome)
  assert.equal(result.status, 'completed')
  assert.equal(prompts.length, 0)
  assert.deepEqual(world.dispatched, [])
})

test('waitEvent consumes the event it waited for', async (t) => {
  // "openwindow" is a hard fatal foreign event, so the following assert step only
  // passes when waitEvent removed it from the ambient window.
  const plan = planOf([
    { op: 'waitEvent', kind: 'openwindow', timeoutMs: 500 },
    { op: 'assert' },
  ])
  const world = new FakeWorld()
  const timer = setTimeout(() => {
    world.tap.inject({ event: 'openwindow', data: '0xdead,Alacritty,ghost' })
  }, 20)
  t.after(() => { clearTimeout(timer) })
  const { outcome } = await runPlan(t, plan, world)
  const result = resultOf(outcome)
  assert.equal(result.status, 'completed')
  assert.equal(result.steps[0]?.effect, 'observed openwindow')
})

test('screenshot step captures the anchored region', async (t) => {
  const plan = planOf([
    { op: 'screenshot', label: 'panel', region: { window: { id: '0x55a1' }, rect: [0, 0, 0.5, 0.25] } },
  ])
  const world = new FakeWorld()
  const { outcome } = await runPlan(t, plan, world)
  const result = resultOf(outcome)
  assert.equal(result.status, 'completed')
  assert.deepEqual(world.captures[0]?.region, { x: 100, y: 100, width: 400, height: 150 })
})

test('a screenshot step accepts one window target and rejects combining it with a region', () => {
  const plan = planOf([{ op: 'screenshot', label: 'zen', window: { app: 'zen' } }])
  assert.deepEqual(plan.steps[0]?.window, { app: 'zen' })
  assert.equal(plan.steps[0]?.region, undefined)
  assert.throws(() => planOf([{
    op: 'screenshot',
    region: { window: { id: '0x55a1' }, rect: [0, 0, 1, 1] },
    window: { id: '0x55a1' },
  }]), (error: unknown) => {
    assert.ok(error instanceof PlanValidationError)
    assert.ok(error.issues.some(issue => issue.path === '$.steps[0].window'
      && /either a region or a window, not both/.test(issue.message)))
    return true
  })
})

test('a window screenshot captures the foreign toplevel and records it like any capture', async (t) => {
  const plan = planOf([{ op: 'screenshot', label: 'zen', window: { id: '0x55a1' } }])
  const world = new FakeWorld({ clients: [client({ stableId: '0xabc123' })] })
  const { outcome } = await runPlan(t, plan, world)
  const result = resultOf(outcome)
  assert.equal(result.status, 'completed')
  assert.equal(world.captures.length, 0)
  assert.deepEqual(world.windowCaptures, [{ output: result.screenshots[0]?.path, identifier: '0xabc123' }])
  assert.equal(result.screenshots[0]?.label, 'zen')
  assert.equal(result.steps[0]?.screenshot, result.screenshots[0]?.path)
  assert.match(result.steps[0]?.effect ?? '', /^captured zen \(320x200\)$/)
})

test('a window screenshot faults when the compositor reports no foreign-toplevel identifier', async (t) => {
  const plan = planOf([{ op: 'screenshot', window: { id: '0x55a1' } }])
  const world = new FakeWorld()
  const { outcome } = await runPlan(t, plan, world)
  const result = resultOf(outcome)
  assert.equal(result.status, 'faulted')
  assert.equal(result.fault?.broken.kind, 'target.missing')
  assert.match(result.fault?.broken.detail ?? '', /foreign-toplevel identifier/)
  assert.equal(world.windowCaptures.length, 0)
})

test('a failed window capture faults with the helper message in an ordinary run', async (t) => {
  const plan = planOf([{ op: 'screenshot', window: { id: '0x55a1' } }])
  const world = new FakeWorld({ clients: [client({ stableId: '0xabc123' })] })
  world.windowCaptureError = new HyprscopeError(
    ErrorCode.SCREENSHOT_FAILED, 'the compositor could not capture this window')
  const { outcome } = await runPlan(t, plan, world)
  const result = resultOf(outcome)
  assert.equal(result.status, 'faulted')
  assert.equal(result.fault?.broken.kind, 'postcondition')
  assert.match(result.fault?.broken.detail ?? '', /could not capture this window/)
})

test('the shipped example plan validates and canonicalizes stably', () => {
  const text = readFileSync(new URL('../plans/live-terminal.json', import.meta.url), 'utf8')
  const plan = validatePlan(JSON.parse(text))
  assert.equal(plan.steps.length, 5)
  assert.equal(canonicalJson(plan), canonicalJson(validatePlan(JSON.parse(text))))
})

test('injector arguments carry the lease proof', () => {
  const args = injectorArguments({
    session: { runtimeDir: '/run/user/1000', signature: 'sig', waylandDisplay: 'wayland-1' },
    extent: { width: 2560, height: 1440 },
    lease: { id: 'lease-1', statePath: '/tmp/state.json' },
  })
  const leaseIndex = args.indexOf('--lease-state')
  assert.equal(args[leaseIndex + 1], '/tmp/state.json')
  assert.equal(args[args.indexOf('--lease') + 1], 'lease-1')
  assert.equal(args.includes('--plan'), false)
  assert.deepEqual(args.slice(0, 2), ['--runtime-dir', '/run/user/1000'])
})

test('injector key translation maps modifiers and named keys', () => {
  assert.deepEqual(toInjectorKeys(['CTRL', 'c']), ['LEFTCTRL', 'c'])
  assert.deepEqual(toInjectorKeys(['SUPER', 'Shift', 'F5']), ['LEFTMETA', 'LEFTSHIFT', 'F5'])
  assert.deepEqual(toInjectorKeys(['Escape']), ['Escape'])
  assert.deepEqual(toInjectorKeys(['PageUp']), ['Page_Up'])
})
