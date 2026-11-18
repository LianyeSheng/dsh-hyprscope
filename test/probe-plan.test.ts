/** The probe's measurement plan: a validated plan over the scratch window only. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildProbePlan, PROBE_PLAN_BUDGET_MS, PROBE_PLAN_ID, PROBE_RESIZE, PROBE_WINDOW,
  type ProbeCheckSpec, type ProbePlan, type ProbePlanInput,
} from '../src/compat/probeplan.ts'
import type { CapabilityId } from '../src/compat/types.ts'
import type { Plan, PlanStep, Predicate, WindowTarget } from '../src/plan/model.ts'
import { validatePlan } from '../src/plan/validate.ts'

/** Read-only facts from a machine that reported everything. */
const FULL: ProbePlanInput = { workspace: 'dev', origin: { x: 0, y: 0 }, restoreWindow: '0xABC' }

/** Capabilities a full measurement supplies checks for. */
const FULL_CAPABILITIES: CapabilityId[] = [
  'dispatch.lua',
  'dispatch.focus.workspace',
  'dispatch.focus.window',
  'inject.pointer',
  'inject.keyboard',
  'dispatch.window.float',
  'dispatch.window.pin',
  'dispatch.window.fullscreen-state',
  'dispatch.window.move',
  'dispatch.window.resize',
]

/** Reason the probe's consent card shows. */
const PROBE_REASON = 'installation acceptance: capability probe'

/**
 * Read one step, failing the test instead of returning undefined.
 * @param plan Validated plan.
 * @param index Zero-based step index.
 * @returns The step.
 */
function stepAt(plan: Plan, index: number): PlanStep {
  const step = plan.steps[index]
  if (step === undefined) assert.fail(`missing step ${index}`)
  return step
}

/**
 * List a plan's ops in order.
 * @param plan Validated plan.
 * @returns Op names.
 */
function ops(plan: Plan): string[] {
  return plan.steps.map(step => step.op)
}

/**
 * Find one expected check.
 * @param built Measurement plan.
 * @param capability Capability the check supplies.
 * @param name Check name.
 * @returns The check.
 */
function checkOf(built: ProbePlan, capability: CapabilityId, name: string): ProbeCheckSpec {
  const check = built.checks.find(entry => entry.capability === capability && entry.name === name)
  if (check === undefined) assert.fail(`missing check ${capability}/${name}`)
  return check
}

/**
 * Collect every window selector a plan names, in steps and predicates.
 * @param plan Validated plan.
 * @returns Selectors, with duplicates.
 */
function windowTargets(plan: Plan): WindowTarget[] {
  const found: WindowTarget[] = []
  const takePredicate = (predicate: Predicate): void => {
    if (predicate.target !== undefined) found.push(predicate.target)
  }
  for (const step of plan.steps) {
    if (step.target !== undefined) found.push(step.target)
    if (step.at !== undefined && 'window' in step.at) found.push(step.at.window)
    for (const predicate of step.requires ?? []) takePredicate(predicate)
    for (const predicate of step.expect ?? []) takePredicate(predicate)
  }
  return found
}

test('a full read becomes one validated plan that restores the workspace and focus', () => {
  const built = buildProbePlan(FULL)
  assert.doesNotThrow(() => validatePlan(built.plan))
  const plan = validatePlan(built.plan)
  assert.equal(plan.id, PROBE_PLAN_ID)
  assert.equal(PROBE_PLAN_ID, 'capability-probe')
  assert.equal(plan.reason, PROBE_REASON)
  assert.equal(plan.summary, '测量指针、键盘、窗口状态与工作区的控制能力')
  assert.equal(plan.workspace, null)
  assert.equal(plan.budgetMs, PROBE_PLAN_BUDGET_MS)
  assert.equal(plan.settleMs, 1_000)
  assert.deepEqual(ops(plan), [
    'workspace', 'focusWindow', 'movePointer', 'pause', 'assert', 'chord',
    'floatWindow', 'floatWindow', 'floatWindow', 'floatWindow',
    'fullscreenWindow', 'fullscreenWindow', 'resizeWindow', 'moveWindow',
    'workspace', 'focusWindow',
  ])
  assert.deepEqual(built.moveTarget, { x: 0, y: 0 })
  assert.deepEqual(built.resizeTarget, { width: PROBE_RESIZE.width, height: PROBE_RESIZE.height })
  const restoreWorkspace = stepAt(plan, plan.steps.length - 2)
  assert.equal(restoreWorkspace.op, 'workspace')
  assert.equal(restoreWorkspace.name, 'dev')
  assert.equal(restoreWorkspace.expect, undefined)
  const restoreFocus = stepAt(plan, plan.steps.length - 1)
  assert.equal(restoreFocus.op, 'focusWindow')
  assert.deepEqual(restoreFocus.target, { id: '0xabc' })
  assert.deepEqual(restoreFocus.requires, [{ kind: 'window.exists', target: { id: '0xabc' } }])
  for (const [index, indexOf] of built.checks.entries()) {
    assert.ok(indexOf.steps.length > 0, `check ${index} names a step`)
    for (const step of indexOf.steps) assert.ok(step >= 0 && step < plan.steps.length)
  }
  assert.deepEqual(new Set(built.checks.map(check => check.capability)), new Set(FULL_CAPABILITIES))
  assert.equal(built.limitations.length, 0)
})

test('each check points at the steps that commit it, and names stay unique', () => {
  const built = buildProbePlan(FULL)
  const opsOf = (check: ProbeCheckSpec): string[] => check.steps.map(index => stepAt(built.plan, index).op)
  assert.deepEqual(opsOf(checkOf(built, 'dispatch.lua', 'idempotent-workspace-dispatch')), ['workspace'])
  assert.deepEqual(opsOf(checkOf(built, 'dispatch.focus.workspace', 'focus-active-workspace')), ['workspace'])
  assert.deepEqual(opsOf(checkOf(built, 'dispatch.focus.window', 'focus-scratch')), ['focusWindow'])
  assert.deepEqual(opsOf(checkOf(built, 'inject.pointer', 'pointer-move')), ['movePointer', 'assert'])
  assert.deepEqual(opsOf(checkOf(built, 'inject.keyboard', 'key-f12')), ['chord'])
  assert.equal(checkOf(built, 'inject.keyboard', 'key-f12').verify, 'key-pressed')
  assert.deepEqual(opsOf(checkOf(built, 'dispatch.window.float', 'float-off')), ['floatWindow'])
  assert.deepEqual(opsOf(checkOf(built, 'dispatch.window.float', 'float-on')), ['floatWindow'])
  assert.deepEqual(opsOf(checkOf(built, 'dispatch.window.pin', 'pin-on')), ['floatWindow'])
  assert.deepEqual(opsOf(checkOf(built, 'dispatch.window.pin', 'pin-off')), ['floatWindow'])
  assert.deepEqual(opsOf(checkOf(built, 'dispatch.window.fullscreen-state', 'fullscreen-on')), ['fullscreenWindow'])
  assert.deepEqual(opsOf(checkOf(built, 'dispatch.window.fullscreen-state', 'fullscreen-off')), ['fullscreenWindow'])
  const move = checkOf(built, 'dispatch.window.move', 'move-scratch')
  assert.deepEqual(opsOf(move), ['moveWindow'])
  assert.equal(move.verify, 'geometry-position')
  const resize = checkOf(built, 'dispatch.window.resize', 'resize-scratch')
  assert.deepEqual(opsOf(resize), ['resizeWindow'])
  assert.equal(resize.verify, 'geometry-size')
  for (const capability of new Set(built.checks.map(check => check.capability))) {
    const names = built.checks.filter(check => check.capability === capability).map(check => check.name)
    assert.equal(new Set(names).size, names.length, `${capability} check names are unique`)
  }
  for (const check of built.checks) {
    assert.equal(new Set(check.steps).size, check.steps.length, `${check.name} step indexes are unique`)
  }
})

test('without a workspace name the plan performs no workspace round trip', () => {
  const built = buildProbePlan({ workspace: null, origin: { x: 0, y: 0 }, restoreWindow: null })
  const plan = validatePlan(built.plan)
  assert.ok(!ops(plan).includes('workspace'))
  assert.deepEqual(built.limitations, [
    {
      capability: 'dispatch.lua',
      detail: 'the active workspace name was not read or is not a dispatchable workspace name',
    },
    {
      capability: 'dispatch.focus.workspace',
      detail: 'the active workspace name was not read or is not a dispatchable workspace name',
    },
  ])
  assert.ok(!built.checks.some(check => check.capability === 'dispatch.lua'))
  assert.ok(!built.checks.some(check => check.capability === 'dispatch.focus.workspace'))
  assert.ok(built.checks.some(check => check.capability === 'dispatch.window.move'))
})

test('an invalid workspace name is treated as unread', () => {
  for (const workspace of ['bad name!', '', 'x'.repeat(33), 'рабочий']) {
    const built = buildProbePlan({ workspace, origin: { x: 0, y: 0 }, restoreWindow: null })
    const plan = validatePlan(built.plan)
    assert.ok(!ops(plan).includes('workspace'), `${JSON.stringify(workspace)} is not dispatched`)
    assert.deepEqual(built.limitations.map(entry => entry.capability), ['dispatch.lua', 'dispatch.focus.workspace'])
  }
})

test('without a layout origin the move is limited but the resize still runs', () => {
  const built = buildProbePlan({ workspace: 'dev', origin: null, restoreWindow: null })
  const plan = validatePlan(built.plan)
  assert.ok(!ops(plan).includes('moveWindow'))
  assert.deepEqual(built.limitations, [{
    capability: 'dispatch.window.move',
    detail: 'no monitor layout was read, so the move round trip has no destination',
  }])
  assert.equal(built.moveTarget, null)
  assert.deepEqual(built.resizeTarget, { width: PROBE_RESIZE.width, height: PROBE_RESIZE.height })
  assert.ok(ops(plan).includes('resizeWindow'))
  assert.ok(built.checks.some(check => check.capability === 'dispatch.window.resize'))
  assert.ok(!built.checks.some(check => check.capability === 'dispatch.window.move'))
})

test('without a usable restore address the plan does not touch focus at the end', () => {
  for (const restoreWindow of [null, 'not-an-address', '0xZZZ', ' 0xabc', '0x']) {
    const built = buildProbePlan({ workspace: 'dev', origin: { x: 0, y: 0 }, restoreWindow })
    const plan = validatePlan(built.plan)
    assert.equal(ops(plan).filter(op => op === 'focusWindow').length, 1, `${String(restoreWindow)} adds no focus restore`)
    assert.deepEqual(windowTargets(plan).filter(target => target.id !== undefined), [])
    assert.equal(stepAt(plan, plan.steps.length - 1).op, 'workspace')
  }
})

test('all eight read-fact combinations validate', () => {
  const workspaces: (string | null)[] = [null, 'dev']
  const origins: ProbePlanInput['origin'][] = [null, { x: 0, y: 0 }]
  const windows: (string | null)[] = [null, '0xABC']
  let combinations = 0
  for (const workspace of workspaces) {
    for (const origin of origins) {
      for (const restoreWindow of windows) {
        const built = buildProbePlan({ workspace, origin, restoreWindow })
        const plan = validatePlan(built.plan)
        assert.equal(plan.id, PROBE_PLAN_ID)
        assert.equal(plan.reason, PROBE_REASON)
        assert.ok(plan.steps.length > 0)
        for (const check of built.checks) {
          assert.equal(new Set(check.steps).size, check.steps.length)
          for (const index of check.steps) assert.ok(index >= 0 && index < plan.steps.length)
        }
        combinations += 1
      }
    }
  }
  assert.equal(combinations, 8)
})

test('the plan never names a window other than the scratch client or the restore address', () => {
  const plan = validatePlan(buildProbePlan(FULL).plan)
  const selectors = windowTargets(plan)
  assert.ok(selectors.length > 0)
  for (const selector of selectors) {
    if (selector.id !== undefined) {
      assert.equal(selector.id, '0xabc')
      assert.equal(selector.app, undefined)
      assert.equal(selector.title, undefined)
    } else {
      assert.deepEqual(selector, PROBE_WINDOW)
    }
  }
  assert.deepEqual(PROBE_WINDOW, { app: 'hyprscope-scratch', title: 'hyprscope-scratch' })
  const text = JSON.stringify(plan)
  assert.ok(!text.includes('Alacritty'))
  assert.ok(!text.includes('terminal'))
})

test('the resize step requests exactly PROBE_RESIZE', () => {
  const plan = validatePlan(buildProbePlan(FULL).plan)
  const resize = plan.steps.find(step => step.op === 'resizeWindow')
  assert.ok(resize !== undefined)
  assert.equal(resize.width, PROBE_RESIZE.width)
  assert.equal(resize.height, PROBE_RESIZE.height)
  assert.deepEqual(resize.target, PROBE_WINDOW)
  assert.deepEqual(buildProbePlan(FULL).resizeTarget, { width: 360, height: 240 })
})
