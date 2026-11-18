/**
 * Capability gate for plan execution.
 *
 * A plan is checked against the effective set before any consent card appears:
 * showing the host a card for a plan this machine cannot run wastes the one
 * consent that matters. The gate names the capability and one plain sentence,
 * never a generic "not supported".
 */
import { ErrorCode, HyprscopeError } from '../errors.ts'
import type { Plan } from '../plan/model.ts'
import { CAPABILITY_SPECS, predicateCapabilities, stepCapabilities } from './catalog.ts'
import type { StalenessReport } from './staleness.ts'
import type { CapabilityId, CapabilityLevel, LoadedBaseline } from './types.ts'

/** One reason a plan cannot run on this machine. */
export interface CapabilityIssue {
  /** Where in the plan the dependency appears, such as `$.steps[2]`. */
  path: string
  /** Capability that is missing, or null when no baseline is accepted at all. */
  capability: CapabilityId | null
  /** Code-owned level of the missing capability. */
  level: CapabilityLevel | null
  /** One sentence naming what needs it and why it is unavailable. */
  message: string
}

/** Failure raised when a plan needs a capability the baseline does not grant. */
export class CapabilityError extends HyprscopeError {
  readonly issues: CapabilityIssue[]

  /**
   * @param issues Every missing dependency found in one pass.
   * @param state Aggregate baseline state, or null when there is no baseline.
   */
  constructor(issues: CapabilityIssue[], state: string | null) {
    super(
      ErrorCode.CAPABILITY,
      issues[0]?.message ?? 'This machine cannot run the plan',
      { issues, state },
    )
    this.name = 'CapabilityError'
    this.issues = issues
  }
}

/**
 * Collect every capability a plan needs that the baseline does not grant.
 *
 * A missing baseline is itself the first issue: nothing may run without an
 * accepted baseline, so listing per-step details would only obscure that.
 * @param plan Validated plan.
 * @param baseline Accepted baseline, or null.
 * @returns Issues in plan order; empty when the plan may run.
 */
export function planCapabilityIssues(plan: Plan, baseline: LoadedBaseline | null): CapabilityIssue[] {
  if (baseline === null) {
    return [{
      path: '$',
      capability: null,
      level: null,
      message: 'No accepted capability baseline exists on this machine, so control is unavailable; '
        + 'run "hyprscope control baseline --probe" and accept the result first',
    }]
  }
  if (baseline.state === 'incomplete') return missingRequiredIssues(baseline)
  const issues: CapabilityIssue[] = []
  const seen = new Set<CapabilityId>()
  /** Record one missing dependency the first time it appears. */
  const reject = (path: string, capability: CapabilityId, neededBy: string): void => {
    if (baseline.effective.has(capability) || seen.has(capability)) return
    seen.add(capability)
    const spec = CAPABILITY_SPECS[capability]
    issues.push({
      path,
      capability,
      level: spec.level,
      message: `${neededBy} needs capability "${capability}" (${spec.level}), which this machine's baseline does not support`,
    })
  }
  for (const [index, step] of plan.steps.entries()) {
    const path = `$.steps[${index}]`
    for (const capability of stepCapabilities(step)) reject(path, capability, `step ${index + 1} "${step.op}"`)
    for (const predicate of [...(step.requires ?? []), ...(step.expect ?? [])]) {
      for (const capability of predicateCapabilities(predicate)) {
        reject(path, capability, `step ${index + 1} predicate "${predicate.kind}"`)
      }
    }
  }
  return issues
}

/**
 * Require that the plan may run on this machine.
 * @param plan Validated plan.
 * @param baseline Accepted baseline, or null.
 * @throws CapabilityError listing every missing dependency.
 */
export function assertPlanCapabilities(plan: Plan, baseline: LoadedBaseline | null): void {
  const issues = planCapabilityIssues(plan, baseline)
  if (issues.length > 0) throw new CapabilityError(issues, baseline?.state ?? null)
}

/**
 * List the required capabilities an incomplete baseline failed to measure.
 * @param baseline Accepted baseline whose state is `incomplete`.
 * @returns One issue per unmeasured required capability.
 */
export function missingRequiredIssues(baseline: LoadedBaseline): CapabilityIssue[] {
  const issues: CapabilityIssue[] = []
  for (const id of Object.keys(CAPABILITY_SPECS) as CapabilityId[]) {
    const spec = CAPABILITY_SPECS[id]
    if (spec.level !== 'required' || baseline.effective.has(id)) continue
    issues.push({
      path: '$',
      capability: id,
      level: 'required',
      message: `The required capability "${id}" is not measured as supported, so this machine cannot take control`,
    })
  }
  return issues
}

/**
 * Require that control is possible at all, before any plan is considered.
 * @param baseline Accepted baseline, or null.
 * @throws CapabilityError naming each required capability that is unmeasured.
 */
export function assertControlAvailable(baseline: LoadedBaseline | null): void {
  const issues = baseline === null ? planCapabilityIssues(emptyPlan(), null) : missingRequiredIssues(baseline)
  if (issues.length > 0) throw new CapabilityError(issues, baseline?.state ?? null)
}

/**
 * Require that the baseline still describes the running desktop.
 *
 * A stale baseline measured a different configuration, so its verdict says
 * nothing about the desktop in front of us; an unverified one predates drift
 * tracking. Both fail closed with the re-probe command in the message.
 * @param staleness Comparison with the running instance, or null when it was not checked.
 * @throws CapabilityError when the baseline may not gate control.
 */
export function assertFreshBaseline(staleness: StalenessReport | null): void {
  const issues = freshnessIssues(staleness)
  if (issues.length > 0) throw new CapabilityError(issues, null)
}

/**
 * List why a baseline may not gate control, if it may not.
 * @param staleness Comparison with the running instance, or null when it was not checked.
 * @returns One issue, or none when control may proceed.
 */
export function freshnessIssues(staleness: StalenessReport | null): CapabilityIssue[] {
  if (staleness === null) {
    return [{
      path: '$', capability: null, level: null,
      message: 'The accepted baseline was not compared with the running desktop, so control is unavailable; run "hyprscope doctor" to see why',
    }]
  }
  if (staleness.verdict === 'fresh') return []
  const command = 'run "hyprscope control baseline --probe" and accept the result'
  if (staleness.verdict === 'unverified') {
    return [{
      path: '$', capability: null, level: null,
      message: `The accepted baseline does not record the effective configuration (${staleness.reasons[0] ?? 'no recorded values'}), so control is unavailable; ${command}`,
    }]
  }
  const fields = staleness.differences.map(difference => difference.field).join(', ')
  return [{
    path: '$', capability: null, level: null,
    message: `The accepted baseline no longer matches the running desktop${fields === '' ? '' : ` (${fields})`}, so control is unavailable; ${command}`,
  }]
}

/** @returns Smallest valid plan, used to reuse the no-baseline message. */
function emptyPlan(): Plan {
  return {
    version: 1, id: 'gate', reason: 'gate', summary: null, workspace: null,
    budgetMs: 1, settleMs: 1, interferencePromptMs: 1, steps: [],
  }
}
