/** Pure recovery planning: restorability, restore synthesis, and derived plans. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Plan, PlanStep, Predicate } from '../src/plan/model.ts'
import {
  deriveResumePlan, restorability, synthesizeRestoreSteps,
  type Geometry, type Restorability, type Violation,
} from '../src/plan/recover.ts'
import type { Snapshot } from '../src/plan/targets.ts'
import { PlanValidationError, validatePlan } from '../src/plan/validate.ts'
import type { Client, Monitor } from '../src/types.ts'

const FLOAT_ID = '0xaa01'
const TILED_ID = '0xbb02'
const MISSING_ID = '0xdead'

/**
 * Build a client with deterministic geometry.
 * @param overrides Fields to replace.
 * @returns Client record.
 */
function client(overrides: Partial<Client> = {}): Client {
  return {
    windowId: FLOAT_ID,
    app: 'Alacritty',
    initialApp: 'Alacritty',
    title: 'terminal',
    pid: 4242,
    monitor: 0,
    workspace: { id: 1, name: 'agent' },
    position: { x: 100, y: 100 },
    size: { width: 800, height: 600 },
    floating: true,
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

/**
 * Build a snapshot around a set of clients.
 * @param clients Current clients.
 * @returns Snapshot record.
 */
function snapshot(clients: Client[]): Snapshot {
  return { observedAt: 0, clients, monitors: [monitor()], activeWindow: clients[0] ?? null }
}

/**
 * Build one broken-premise violation from its predicate.
 * @param predicate Premise that broke.
 * @param detail Human-readable reason.
 * @returns Violation marked restorable (synthesis recomputes the verdict).
 */
function violationFor(predicate: Predicate, detail = 'broken premise'): Violation {
  return {
    kind: predicate.kind,
    detail,
    target: predicate.target ?? null,
    expected: null,
    observed: null,
    restorable: true,
    predicate,
  }
}

/**
 * Validate a plan literal into a plan.
 * @param steps Plan steps.
 * @param extra Top-level fields.
 * @returns Validated plan.
 */
function planOf(steps: unknown[], extra: Record<string, unknown> = {}): Plan {
  return validatePlan({ version: 1, reason: 'recover test plan', steps, ...extra })
}

/**
 * Unwrap a restorability refusal.
 * @param verdict Verdict to check.
 * @returns Refusal reason.
 */
function reasonOf(verdict: Restorability): string {
  if (verdict.ok) assert.fail(`expected a refusal, got the restore template "${verdict.restore}"`)
  return verdict.reason
}

const BASELINE: Geometry = { x: 100, y: 100, width: 800, height: 600 }
const base = snapshot([
  client({ windowId: FLOAT_ID, app: 'Alacritty', floating: true }),
  client({ windowId: TILED_ID, app: 'foot', floating: false }),
])

test('restorability accepts every restorable predicate kind', () => {
  const cases: { predicate: Predicate; restore: Restorability; baseline: Geometry | null }[] = [
    { predicate: { kind: 'window.focused', target: { id: FLOAT_ID } }, restore: { ok: true, restore: 'focus' }, baseline: null },
    { predicate: { kind: 'window.focused', target: { app: 'Alacritty' } }, restore: { ok: true, restore: 'focus' }, baseline: null },
    { predicate: { kind: 'window.state', target: { id: TILED_ID }, floating: true }, restore: { ok: true, restore: 'state' }, baseline: null },
    { predicate: { kind: 'window.state', target: { id: TILED_ID }, fullscreen: 2 }, restore: { ok: true, restore: 'state' }, baseline: null },
    { predicate: { kind: 'workspace.active', name: 'agent' }, restore: { ok: true, restore: 'workspace' }, baseline: null },
    { predicate: { kind: 'window.geometry', target: { id: FLOAT_ID } }, restore: { ok: true, restore: 'geometry' }, baseline: BASELINE },
    {
      predicate: { kind: 'window.geometry', target: { id: FLOAT_ID }, x: 200, y: 300, width: 640, height: 480 },
      restore: { ok: true, restore: 'geometry' },
      baseline: null,
    },
    { predicate: { kind: 'pointer.position', x: 10, y: 20 }, restore: { ok: true, restore: 'pointer' }, baseline: null },
    {
      predicate: { kind: 'pointer.position', target: { id: FLOAT_ID }, point: [0.5, 0.5] },
      restore: { ok: true, restore: 'pointer' },
      baseline: null,
    },
  ]
  for (const entry of cases) {
    const verdict = restorability({ predicate: entry.predicate, snapshot: base, cursor: { x: 0, y: 0 }, baseline: entry.baseline })
    assert.deepEqual(verdict, entry.restore, JSON.stringify(entry.predicate))
  }
})

test('restorability refuses every non-restorable predicate kind', () => {
  const predicates: Predicate[] = [
    { kind: 'window.exists', target: { id: FLOAT_ID } },
    { kind: 'clients.set', ids: [FLOAT_ID] },
    { kind: 'monitor.config', name: 'DP-1', width: 2560 },
    { kind: 'region.unchanged', target: { id: FLOAT_ID }, rect: [0, 0, 1, 1] },
    { kind: 'region.changed', target: { id: FLOAT_ID }, rect: [0, 0, 1, 1] },
    { kind: 'lease.valid' },
    { kind: 'time.budget' },
    { kind: 'no.foreign_event' },
  ]
  for (const predicate of predicates) {
    const reason = reasonOf(restorability({ predicate, snapshot: base, cursor: { x: 0, y: 0 }, baseline: null }))
    assert.match(reason, /cannot be re-established by the tool/, predicate.kind)
  }
})

test('restorability rejects restore templates whose inputs are missing', () => {
  const cases: { predicate: Predicate; reason: RegExp; baseline?: Geometry | null }[] = [
    { predicate: { kind: 'window.focused', target: { id: MISSING_ID } }, reason: /not present/ },
    { predicate: { kind: 'window.focused' }, reason: /names no window/ },
    { predicate: { kind: 'window.state', target: { id: MISSING_ID } }, reason: /not present/ },
    { predicate: { kind: 'window.state', floating: true }, reason: /names no window/ },
    { predicate: { kind: 'window.geometry', target: { id: TILED_ID }, x: 1, y: 2, width: 800, height: 600 }, reason: /tiled/ },
    { predicate: { kind: 'window.geometry', target: { id: MISSING_ID } }, reason: /not present/ },
    { predicate: { kind: 'window.geometry', target: { id: FLOAT_ID } }, reason: /no baseline geometry/, baseline: null },
    { predicate: { kind: 'workspace.active' }, reason: /names no workspace/ },
    { predicate: { kind: 'pointer.position', target: { id: MISSING_ID }, point: [0.5, 0.5] }, reason: /not present/ },
    { predicate: { kind: 'pointer.position', target: { id: FLOAT_ID } }, reason: /needs a point/ },
    { predicate: { kind: 'pointer.position' }, reason: /carries no position/ },
  ]
  for (const entry of cases) {
    const verdict = restorability({
      predicate: entry.predicate,
      snapshot: base,
      cursor: null,
      baseline: entry.baseline === undefined ? null : entry.baseline,
    })
    assert.match(reasonOf(verdict), entry.reason, JSON.stringify(entry.predicate))
  }
})

test('synthesizeRestoreSteps restores outside-in', () => {
  const floater = client({
    windowId: FLOAT_ID, app: 'float-app', title: 'float', floating: true, fullscreen: 1,
  })
  const tiledClient = client({ windowId: TILED_ID, app: 'tile-app', title: 'tile', floating: false })
  const live = snapshot([floater, tiledClient])
  const plan = planOf([{ op: 'workspace', name: 'agent' }, { op: 'assert' }])
  const floatTarget = { id: FLOAT_ID }
  const tiledTarget = { id: TILED_ID }
  const broken: Violation[] = [
    violationFor({ kind: 'workspace.active', name: 'agent' }),
    violationFor({ kind: 'window.state', target: tiledTarget, floating: true }),
    violationFor({ kind: 'window.geometry', target: floatTarget, x: 300, y: 200, width: 640, height: 480 }),
    violationFor({ kind: 'window.focused', target: tiledTarget }),
    violationFor({ kind: 'pointer.position', target: floatTarget, point: [0.5, 0.5] }),
  ]
  const outcome = synthesizeRestoreSteps({
    plan,
    stepIndex: 0,
    broken,
    snapshot: live,
    cursor: { x: 0, y: 0 },
    baselineGeometry: new Map([[FLOAT_ID, BASELINE]]),
  })
  if (!outcome.ok) assert.fail(outcome.reason)
  const exists = (target: unknown): unknown[] => [{ kind: 'window.exists', target }]
  const floating = (target: unknown): unknown => ({ kind: 'window.state', target, floating: true })
  assert.deepEqual(outcome.steps, [
    { op: 'workspace', name: 'agent' },
    { op: 'floatWindow', target: tiledTarget, floating: true, requires: exists(tiledTarget) },
    { op: 'fullscreenWindow', target: floatTarget, internal: 0, client: 0, requires: exists(floatTarget) },
    {
      op: 'moveWindow', target: floatTarget, x: 300, y: 200,
      requires: [...exists(floatTarget), floating(floatTarget)],
    },
    {
      op: 'resizeWindow', target: floatTarget, width: 640, height: 480,
      requires: [...exists(floatTarget), floating(floatTarget)],
    },
    { op: 'focusWindow', target: tiledTarget, requires: exists(tiledTarget) },
    { op: 'movePointer', at: { window: floatTarget, point: [0.5, 0.5] } },
  ])
  assert.deepEqual(outcome.restored, [
    'workspace.active', 'window.state', 'window.geometry', 'window.focused', 'pointer.position',
  ])
  assert.equal(outcome.summary, '恢复工作区、窗口状态、窗口几何、焦点、指针后继续第 1/2 步')
})

test('synthesizeRestoreSteps refuses to restore a tiled window geometry', () => {
  const tiledClient = client({ windowId: TILED_ID, floating: false })
  const plan = planOf([{ op: 'assert' }])
  const outcome = synthesizeRestoreSteps({
    plan,
    stepIndex: 0,
    broken: [violationFor({ kind: 'window.geometry', target: { id: TILED_ID }, x: 1, y: 2, width: 800, height: 600 })],
    snapshot: snapshot([tiledClient]),
    cursor: null,
    baselineGeometry: new Map(),
  })
  if (outcome.ok) assert.fail('a tiled window geometry must not be restorable')
  assert.equal(outcome.kind, 'window.geometry')
  assert.match(outcome.reason, /tiled/)
})

test('synthesizeRestoreSteps refuses a premise whose target window is missing', () => {
  const plan = planOf([{ op: 'assert' }])
  const outcome = synthesizeRestoreSteps({
    plan,
    stepIndex: 0,
    broken: [violationFor({ kind: 'window.focused', target: { id: MISSING_ID } })],
    snapshot: snapshot([client({ windowId: FLOAT_ID })]),
    cursor: null,
    baselineGeometry: new Map(),
  })
  if (outcome.ok) assert.fail('a missing target must not be restorable')
  assert.equal(outcome.kind, 'window.focused')
  assert.match(outcome.reason, /not present/)
})

test('deriveResumePlan continues from the interrupted step under a new lineage', () => {
  const plan = planOf([
    { op: 'workspace', name: 'agent' },
    { op: 'assert' },
    { op: 'screenshot', label: 'after' },
  ], { id: 'root-plan', reason: 'demo root', budgetMs: 4_000 })
  const restoreSteps: PlanStep[] = [{
    op: 'focusWindow', target: { id: FLOAT_ID }, requires: [{ kind: 'window.exists', target: { id: FLOAT_ID } }],
  }]
  const broken = [
    violationFor({ kind: 'pointer.position', x: 1, y: 2 }),
    violationFor({ kind: 'pointer.position', x: 3, y: 4 }),
  ]
  const outcome = deriveResumePlan({
    plan, stepIndex: 1, attempt: 1, broken, restoreSteps, summary: 'restore the pointer',
  })
  if (!outcome.ok) assert.fail(outcome.reason)
  const derived = outcome.plan
  assert.deepEqual(derived.lineage, {
    rootPlanId: 'root-plan',
    attempt: 1,
    interruptedAtStep: 1,
    broken: ['pointer.position'],
  })
  assert.deepEqual(derived.steps, [...restoreSteps, ...plan.steps.slice(1)])
  assert.equal(derived.id, 'root-plan-r1')
  assert.equal(derived.reason, 'demo root (recovery 1)')
  assert.equal(derived.summary, 'restore the pointer')
  assert.equal(derived.workspace, plan.workspace)
  // Each attempt gets a fresh copy of the plan budget, not the leftover of the
  // attempt that suspended.
  assert.equal(derived.budgetMs, 4_000)
  assert.equal(derived.budgetMs, plan.budgetMs)
  // The derived document only becomes valid once the lineage is allowed.
  assert.throws(() => validatePlan(derived), (error: unknown) => {
    assert.ok(error instanceof PlanValidationError)
    assert.ok(error.issues.some(issue => issue.path === '$.lineage'))
    return true
  })
  const validated = validatePlan(derived, { allowLineage: true })
  assert.deepEqual(validated.lineage, derived.lineage)
  assert.equal(validated.steps.length, 3)
})

test('deriveResumePlan preserves the root lineage across attempts', () => {
  const plan = planOf([
    { op: 'workspace', name: 'agent' },
    { op: 'assert' },
  ], { id: 'root-plan', reason: 'demo root', budgetMs: 4_000 })
  const first = deriveResumePlan({
    plan,
    stepIndex: 0,
    attempt: 1,
    broken: [violationFor({ kind: 'workspace.active', name: 'agent' })],
    restoreSteps: [{ op: 'workspace', name: 'agent' }],
    summary: 'restore the workspace',
  })
  if (!first.ok) assert.fail(first.reason)
  const second = deriveResumePlan({
    plan: first.plan,
    stepIndex: 0,
    attempt: 2,
    broken: [violationFor({ kind: 'window.focused', target: { id: FLOAT_ID } })],
    restoreSteps: [{ op: 'focusWindow', target: { id: FLOAT_ID }, requires: [{ kind: 'window.exists', target: { id: FLOAT_ID } }] }],
    summary: 'restore the focus',
  })
  if (!second.ok) assert.fail(second.reason)
  assert.deepEqual(second.plan.lineage, {
    rootPlanId: 'root-plan',
    attempt: 2,
    interruptedAtStep: 0,
    broken: ['window.focused'],
  })
  assert.equal(second.plan.id, 'root-plan-r1-r2')
  assert.doesNotThrow(() => validatePlan(second.plan, { allowLineage: true }))
})

test('deriveResumePlan refuses a plan with no remaining work', () => {
  const plan = planOf([{ op: 'assert' }, { op: 'assert' }])
  const outcome = deriveResumePlan({
    plan,
    stepIndex: plan.steps.length,
    attempt: 1,
    broken: [violationFor({ kind: 'pointer.position', x: 1, y: 2 })],
    restoreSteps: [],
    summary: 'nothing to do',
  })
  if (outcome.ok) assert.fail('a plan with no remaining work must not derive')
  assert.match(outcome.reason, /no remaining work/)
})

test('deriveResumePlan refuses a plan over the step limit', () => {
  const plan = planOf(Array.from({ length: 64 }, () => ({ op: 'assert' })))
  const restoreSteps: PlanStep[] = Array.from({ length: 64 }, () => ({ op: 'assert' }))
  const outcome = deriveResumePlan({
    plan,
    stepIndex: 63,
    attempt: 1,
    broken: [violationFor({ kind: 'pointer.position', x: 1, y: 2 })],
    restoreSteps,
    summary: 'too many steps',
  })
  if (outcome.ok) assert.fail('a derived plan over the step limit must not derive')
  assert.match(outcome.reason, /step limit/)
})
