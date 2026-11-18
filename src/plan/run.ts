/**
 * `hyprscope control run`: validate a plan, execute it under the lease the host
 * approves, and give control back no matter how the run ends.
 *
 * The plan document arrives once, either as a file or on stdin, and is loaded
 * exactly once: the validated object in memory is what the consent covers, so
 * nothing written elsewhere afterwards can widen the approved attempt.
 *
 * When a restorable premise breaks and the host chooses to continue, the run
 * suspends instead of repairing in place: the tool derives a recovery plan from
 * the broken premises, renews the lease for that new attempt (new time budget),
 * and executes it. Recovery therefore reuses the normal execution path — same
 * dispatcher subset, same lease gate, same receipts.
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { readBaseline } from '../compat/baseline.ts'
import { CAPABILITY_IDS, CAPABILITY_SPECS } from '../compat/catalog.ts'
import { assertControlAvailable, assertFreshBaseline, assertPlanCapabilities, CapabilityError } from '../compat/gate.ts'
import { compareEffective, measureEffective } from '../compat/staleness.ts'
import type { StalenessReport } from '../compat/staleness.ts'
import type { BaselineState, LoadedBaseline } from '../compat/types.ts'
import { hashDesktopConfig } from '../desktop/config.ts'
import { statusDesktop } from '../desktop/lifecycle.ts'
import { resolveTarget } from '../desktop/target.ts'
import type { DesktopTarget, ResolvedTarget } from '../desktop/types.ts'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import { grantLease, LEASE_RECOVERY_MARGIN_MS, releaseLease, renewLease, requestLease } from '../lease/control.ts'
import {
  clearInterference, clearInterferenceDecision, clearNotice, leasePaths, readInterferenceDecision,
  writeInterference, writeNotice, writeProgress, type LeaseProgress,
} from '../lease/state.ts'
import {
  executePlan, type ExecutionOutcome, type FaultRecord, type InterferenceRequest, type RunResult, type SuspendRecord,
} from './executor.ts'
import { assertPlanGrant, requirePlanGrant, type PlanGrant } from './leasegate.ts'
import { PLAN_LIMITS, type Plan } from './model.ts'
import { describePlanCard } from './card.ts'
import { deriveResumePlan, synthesizeRestoreSteps } from './recover.ts'
import { RunStore } from './runstore.ts'
import { summarizePlan, validatePlan, type PlanSummary } from './validate.ts'
import { LiveWorld, observeCursor, observeSnapshot } from './world.ts'

/** Options for {@link runPlanFile}. Exactly one of `file` and `text` is required. */
export interface RunPlanOptions {
  /** Path to a JSON plan file. */
  file?: string
  /** Plan JSON read from stdin, for one-shot submissions. */
  text?: string
  consentMs?: number
  ttlMs?: number
  env?: NodeJS.ProcessEnv
  /** Desktop to run against; omitted means the user's own desktop. */
  desktop?: DesktopTarget
  /** Recovery attempts the consent card may authorize. */
  maxResumes?: number
}

/** Everything the gate decided before a run may ask for control. */
export interface PlanCheck {
  target: ResolvedTarget
  baseline: LoadedBaseline
  baselineReceipt: BaselineReceipt
  staleness: StalenessReport
}

/** A plan as it would be approved. */
export interface PlanPreview {
  plan: Plan
  summary: PlanSummary
}

/** One attempt of a run that may recover from interference. */
export interface AttemptSummary {
  attempt: number
  runId: string
  dir: string
  status: 'completed' | 'faulted' | 'revoked' | 'suspended'
  steps: number
  /** Kind of the fault, or of the broken premise that suspended the attempt. */
  broken: string | null
}

/** Receipt for the capability baseline a run was gated by. */
export interface BaselineReceipt {
  /** Aggregate state the baseline recomputed to. */
  state: BaselineState
  /** When a human accepted this baseline, ISO 8601. */
  approvedAt: string
  /** Compositor version the baseline was measured on, when it recorded one. */
  compositorVersion: string | null
  /** Degraded capabilities the baseline does not grant (missing safety paths). */
  degraded: string[]
}

/** Final report of a run, including any recovery attempts. */
export interface RunReport extends RunResult {
  rootRunId: string
  rootDir: string
  attempts: AttemptSummary[]
  /** Desktop this run addressed; a receipt can never be read as another desktop's. */
  target: { kind: DesktopTarget; signature: string; managed: boolean }
  /** Capability baseline this run was gated by; fixed for the whole run. */
  baseline: BaselineReceipt
}

/**
 * Read and validate a plan document from a file.
 * @param file Path to a JSON plan.
 * @returns Validated plan.
 */
export async function loadPlan(file: string): Promise<Plan> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new HyprscopeError(ErrorCode.USAGE, `Cannot read plan file ${file}`, {
      file, cause: error instanceof Error ? error.message : String(error),
    })
  }
  return loadPlanText(text, `Plan file ${file}`)
}

/**
 * Parse and validate a plan document that is already in memory.
 * @param text JSON document.
 * @param label What the document is, for error messages.
 * @returns Validated plan.
 */
export function loadPlanText(text: string, label = 'Plan input'): Plan {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HyprscopeError(ErrorCode.PLAN_INVALID, `${label} is not JSON`, { source: label })
  }
  // An authored document may never claim a recovery lineage: the tool creates it.
  return validatePlan(parsed)
}

/**
 * Describe what approving this plan would mean.
 * @param plan Validated plan.
 * @returns The plan and its consent-card summary.
 */
export function previewPlan(plan: Plan): PlanPreview {
  return { plan, summary: summarizePlan(plan) }
}

/**
 * Resolve the target and refuse a plan this desktop cannot run right now.
 *
 * The order matters: capability, then freshness, then the plan's own needs. A
 * stale baseline is not evidence about the running configuration, so it is
 * refused before any per-step verdict is trusted, and both refusals happen
 * before a consent card can appear.
 * @param plan Validated plan.
 * @param options Desktop selector and environment.
 * @returns The target, baseline, receipt, and staleness verdict.
 */
export async function checkPlan(
  plan: Plan,
  options: { env?: NodeJS.ProcessEnv; desktop?: DesktopTarget } = {},
): Promise<PlanCheck> {
  const env = options.env ?? process.env
  const target = await resolveTarget(options.desktop ?? 'user', { env })
  const baselineRead = await readBaseline(env, { signature: target.baselineSignature })
  assertControlAvailable(baselineRead.loaded)
  const baseline: LoadedBaseline = baselineRead.loaded!
  const currentConfigHash = target.desktop === null || target.desktop.configDir === ''
    ? null
    : await hashDesktopConfig(target.desktop.configDir).catch(() => null)
  const observed = await measureEffective(target.session)
  const staleness = compareEffective(baseline.document.fingerprint, observed, {
    configHash: currentConfigHash,
    approvedAt: baseline.approvedAt,
  })
  assertFreshBaseline(staleness)
  assertPlanCapabilities(plan, baseline)
  return { target, baseline, baselineReceipt: baselineReceipt(baseline), staleness }
}

/**
 * Build the receipt for one accepted baseline.
 * @param baseline Baseline that gates the run.
 * @returns Aggregate state, approval time, compositor version, and the degraded capabilities it does not grant.
 */
function baselineReceipt(baseline: LoadedBaseline): BaselineReceipt {
  return {
    state: baseline.state,
    approvedAt: baseline.approvedAt,
    compositorVersion: baseline.document.fingerprint.compositor.version,
    degraded: CAPABILITY_IDS.filter(id => CAPABILITY_SPECS[id].level === 'degraded' && !baseline.effective.has(id)),
  }
}

/**
 * Publish or clear the interference notice the overlay reads.
 * @param env Environment that owns the lease state.
 * @param leaseId Current lease.
 * @param notice Notice to show, or null to clear.
 */
async function publishNotice(env: NodeJS.ProcessEnv, leaseId: string, notice: { text: string; ttlMs: number } | null): Promise<void> {
  const paths = leasePaths(env)
  if (notice === null) {
    await clearNotice(paths)
    return
  }
  await writeNotice(paths, {
    leaseId,
    text: notice.text,
    at: new Date().toISOString(),
    expiresAt: new Date(Date.now() + notice.ttlMs).toISOString(),
  })
}

/**
 * Publish execution progress for the overlay.
 * @param env Environment that owns the lease state.
 * @param record Progress record.
 */
async function publishProgress(env: NodeJS.ProcessEnv, record: LeaseProgress): Promise<void> {
  await writeProgress(leasePaths(env), record)
}

/** @param ms Delay in milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Ask the host whether to recover from restorable interference.
 *
 * Publishes the prompt record the overlay renders, then waits for the decision
 * file, the deadline, or a lease revocation. The prompt and its answer are
 * cleared on every exit path.
 * @param env Environment that owns the lease state.
 * @param grant Current lease grant.
 * @param runId Run that hit the interference.
 * @param request Interference facts from the executor.
 * @returns `continue` to derive a recovery attempt, `abort` to end the run.
 */
async function promptInterference(
  env: NodeJS.ProcessEnv,
  grant: PlanGrant,
  runId: string,
  request: InterferenceRequest,
): Promise<'continue' | 'abort'> {
  const paths = leasePaths(env)
  const id = randomUUID()
  const expiresAt = new Date(Date.now() + request.timeoutMs).toISOString()
  const first = request.broken[0]
  await writeInterference(paths, {
    leaseId: grant.leaseId,
    runId,
    id,
    step: request.step,
    total: request.total,
    kind: first?.kind ?? 'interference',
    detail: first?.detail ?? 'a declared premise no longer holds',
    at: new Date().toISOString(),
    expiresAt,
    attempt: request.attempt + 1,
    maxResumes: request.maxResumes,
    budgetMs: request.budgetMs,
    broken: request.broken.map(item => ({
      kind: item.kind, detail: item.detail, expected: item.expected, observed: item.observed,
    })),
  })
  try {
    for (;;) {
      await assertPlanGrant(grant, env)
      const decision = await readInterferenceDecision(paths)
      if (decision !== null && decision.id === id) return decision.decision
      if (Date.now() >= Date.parse(expiresAt)) return 'abort'
      await delay(100)
    }
  } finally {
    await clearInterference(paths).catch(() => {})
    await clearInterferenceDecision(paths).catch(() => {})
  }
}

/**
 * Build the fault result for a suspension the tool refuses to recover.
 * @param suspended Interrupted attempt.
 * @param kind Refusal kind.
 * @param reason Why recovery is impossible.
 * @returns Fault result in the shape of a finished run.
 */
/**
 * Identify the desktop in a run receipt.
 * @param target Resolved target.
 * @returns Target kind, signature, and whether it is a managed desktop.
 */
function targetReceipt(target: ResolvedTarget): RunReport['target'] {
  return { kind: target.target, signature: target.session.signature, managed: target.desktop !== null }
}

/**
 * Rewrite a fault when the desktop it addressed is no longer there.
 *
 * Closing the nested window destroys the compositor, so every in-flight step
 * fails with an unreachable session; the useful fact is that the target itself
 * is gone, and the agent must ask the human in the conversation what happened.
 * @param result Finished attempt.
 * @param target Resolved target.
 * @returns The same result, or one faulted with `target.desktop-closed`.
 */
async function mapDesktopClosed(result: RunResult, target: ResolvedTarget): Promise<RunResult> {
  if (target.target === 'user' || result.status !== 'faulted' || result.fault === null) return result
  const status = await statusDesktop(target.env).catch(() => null)
  // A config-hash mismatch also makes the record stale; only a vanished process
  // or instance means the desktop itself is gone.
  if (status === null || (status.checks.pid && status.checks.instance)) return result
  return {
    ...result,
    fault: {
      ...result.fault,
      broken: {
        ...result.fault.broken,
        kind: 'target.desktop-closed',
        detail: `${result.fault.broken.detail} (the ${target.target} desktop is ${status.state})`,
      },
    },
  }
}

function faultFromSuspension(suspended: SuspendRecord, kind: string, reason: string): RunResult {
  const detectedAt = new Date().toISOString()
  const fault: FaultRecord = {
    runId: suspended.runId,
    status: 'faulted',
    step: suspended.step,
    broken: { kind, detail: reason, expected: null, observed: null, detectedAt },
    committed: suspended.committed,
    lastConfirmedEffect: suspended.lastConfirmedEffect,
    screenshot: null,
    timeline: suspended.timeline,
  }
  return {
    runId: suspended.runId,
    status: 'faulted',
    steps: suspended.steps,
    fault,
    screenshots: suspended.screenshots,
    startedAt: suspended.startedAt,
    finishedAt: detectedAt,
    durationMs: suspended.durationMs,
    dir: suspended.dir,
  }
}

/**
 * Execute a plan file after asking the human for consent.
 *
 * Recovery is a derived-plan loop: the first attempt may suspend for a
 * restorable interference, each recovery attempt renews the lease and runs a
 * plan made of restore steps plus the work that had not started, and no
 * recovery attempt may recover again.
 * @param options Plan source, consent bounds, and recovery allowance.
 * @returns Run report; control is released before this resolves.
 */
export async function runPlanFile(options: RunPlanOptions): Promise<RunReport> {
  const env = options.env ?? process.env
  if ((options.file === undefined) === (options.text === undefined)) {
    throw new HyprscopeError(ErrorCode.USAGE, 'run needs exactly one plan source', {})
  }
  const rootPlan = options.text === undefined
    ? await loadPlan(options.file as string)
    : loadPlanText(options.text, 'Plan input')
  // Capability is decided before the consent card: a plan this machine cannot
  // run must never ask the host for control. The target is resolved once, the
  // baseline is read once, and both are fixed for the whole run; the plan was
  // parsed once above, so a later write to a file cannot widen the attempt the
  // host already approved.
  const check = await checkPlan(rootPlan, { env, desktop: options.desktop })
  const baseline: LoadedBaseline = check.baseline
  const baselineReport = check.baselineReceipt
  const target = check.target
  const runEnv = target.env
  const summary = summarizePlan(rootPlan)
  const maxResumes = Math.max(0, Math.min(options.maxResumes ?? PLAN_LIMITS.defaultMaxResumes, PLAN_LIMITS.maxResumes))
  const recoveryBudgetMs = rootPlan.budgetMs
  /** Time the lease holds for one attempt: its plan budget plus one prompt margin. */
  const attemptTtlMs = (plan: Plan): number => plan.budgetMs + LEASE_RECOVERY_MARGIN_MS
  const request = {
    reason: rootPlan.reason,
    planBound: true,
    planSummary: summary,
    // The card shows what the host is approving: the plan's description and its
    // steps, not just an op list. The compact summary still drives the banner.
    card: describePlanCard(rootPlan),
    ttlMs: options.ttlMs ?? attemptTtlMs(rootPlan),
    maxResumes,
    totalBudgetMs: recoveryBudgetMs * (1 + maxResumes),
  }
  // Inside a desktop the human already approved, the desktop is the consent
  // boundary: the lease is granted programmatically, still bound to this plan
  // and TTL. The user's desktop keeps the per-run card.
  const consents = target.target === 'user'
    ? await requestLease({ ...request, consentMs: options.consentMs, env })
    : await grantLease({ ...request, env: runEnv, source: 'desktop' })
  if (!consents.allowed || consents.phase !== 'granted') {
    throw new HyprscopeError(ErrorCode.DENIED, `Consent was not granted (${consents.reason})`, {
      leaseId: consents.leaseId, phase: consents.phase,
    })
  }
  const session = target.session
  const rootStore = new RunStore()
  let grant = await requirePlanGrant(runEnv)
  let total = rootPlan.steps.length
  const attempts: AttemptSummary[] = []
  let report: RunResult | null = null
  let plan = rootPlan
  let outcome: RunReport | null = null

  try {
    for (let attempt = 0; attempt <= maxResumes; attempt += 1) {
      const store = attempt === 0 ? rootStore : new RunStore()
      const attemptNumber = attempt
      const world = new LiveWorld({
        session,
        assertGrant: () => assertPlanGrant(grant, runEnv),
        lease: { id: grant.leaseId, statePath: leasePaths(runEnv).stateFile },
      })
      let execution: ExecutionOutcome
      try {
        execution = await executePlan({
          plan,
          grant,
          world,
          store,
          checkLease: () => assertPlanGrant(grant, runEnv),
          resumeAllowed: attempt === 0 && maxResumes > 0,
          attempt: attemptNumber,
          maxResumes,
          recoveryBudgetMs,
          capabilities: baseline.effective,
          onProgress: update => publishProgress(runEnv, {
            leaseId: grant.leaseId,
            runId: store.runId,
            status: 'running',
            step: update.step,
            total: update.total,
            op: update.op,
            reason: null,
            at: new Date().toISOString(),
            attempt: attemptNumber,
            maxResumes,
            // A derived attempt is a recovery for its whole duration: its first
            // steps rebuild the premises and the rest continues the plan.
            phase: attemptNumber > 0 ? 'recovering' : 'running',
          }).catch(() => {}),
          // The interference prompt lives in the lease overlay, which only the
          // user's desktop has. Inside a managed desktop nobody could answer it,
          // so a conflict faults and the agent asks in the conversation instead.
          onInterference: attempt === 0 && target.target === 'user'
            ? request => promptInterference(runEnv, grant, store.runId, request)
            : undefined,
        })
      } catch (error) {
        report = faultFromSuspension(emptySuspension(store), 'executor-error', error instanceof Error ? error.message : String(error))
        attempts.push({ attempt: attemptNumber, runId: store.runId, dir: store.dir, status: 'faulted', steps: 0, broken: 'executor-error' })
        break
      }
      if (execution.kind === 'done') {
        report = execution.result
        attempts.push({
          attempt: attemptNumber, runId: store.runId, dir: store.dir, status: execution.result.status,
          steps: execution.result.steps.length, broken: execution.result.fault?.broken.kind ?? null,
        })
        break
      }
      // Suspension: the host agreed to recover, so derive the next attempt.
      const suspended = execution.record
      total = plan.steps.length
      attempts.push({
        attempt: attemptNumber, runId: store.runId, dir: store.dir, status: 'suspended',
        steps: suspended.steps.length, broken: suspended.broken[0]?.kind ?? null,
      })
      await publishProgress(runEnv, {
        leaseId: grant.leaseId, runId: store.runId, status: 'running',
        step: suspended.step + 1, total: suspended.total, op: null, reason: null,
        at: new Date().toISOString(), attempt: attemptNumber, maxResumes, phase: 'recovering',
      }).catch(() => {})
      const snapshot = await observeSnapshot(session).catch(() => null)
      const cursor = await observeCursor(session).catch(() => null)
      if (snapshot === null) {
        report = faultFromSuspension(suspended, 'recovery.unavailable', 'the desktop could not be observed for recovery')
        break
      }
      const synthesis = synthesizeRestoreSteps({
        plan,
        stepIndex: suspended.step,
        broken: suspended.broken,
        snapshot,
        cursor,
        baselineGeometry: new Map(Object.entries(suspended.baselineGeometry)),
      })
      if (!synthesis.ok) {
        report = faultFromSuspension(suspended, synthesis.kind, synthesis.reason)
        await rootStore.record({
          at: new Date().toISOString(), kind: 'run.recovery-refused',
          detail: { kind: synthesis.kind, reason: synthesis.reason },
        }).catch(() => {})
        break
      }
      const derived = deriveResumePlan({
        plan,
        stepIndex: suspended.step,
        attempt: attemptNumber + 1,
        broken: suspended.broken,
        restoreSteps: synthesis.steps,
        summary: synthesis.summary,
      })
      if (!derived.ok) {
        report = faultFromSuspension(suspended, 'recovery.invalid', derived.reason)
        break
      }
      let derivedPlan: Plan
      try {
        derivedPlan = validatePlan(derived.plan, { allowLineage: true })
      } catch (error) {
        report = faultFromSuspension(suspended, 'recovery.invalid', error instanceof Error ? error.message : String(error))
        break
      }
      try {
        assertPlanCapabilities(derivedPlan, baseline)
      } catch (error) {
        // A restore step the baseline does not grant must not renew control.
        if (!(error instanceof CapabilityError)) throw error
        report = faultFromSuspension(suspended, 'recovery.capability', error.message)
        await rootStore.record({
          at: new Date().toISOString(), kind: 'run.recovery-refused',
          detail: { kind: 'recovery.capability', reason: error.message },
        }).catch(() => {})
        break
      }
      try {
        await renewLease({
          leaseId: grant.leaseId,
          ttlMs: attemptTtlMs(derivedPlan),
          attempt: attemptNumber + 1,
          env: runEnv,
        })
      } catch (error) {
        report = faultFromSuspension(suspended, 'recovery.lease', error instanceof Error ? error.message : String(error))
        break
      }
      grant = await requirePlanGrant(runEnv)
      plan = derivedPlan
      await rootStore.record({
        at: new Date().toISOString(), kind: 'run.resume',
        detail: {
          attempt: attemptNumber + 1,
          restoreSteps: synthesis.steps.length, summary: synthesis.summary,
        },
      }).catch(() => {})
      await publishNotice(runEnv, grant.leaseId, {
        text: `第 ${attemptNumber + 1} 次恢复：${synthesis.summary}`,
        ttlMs: 4_000,
      }).catch(() => {})
    }
    const finished = report ?? faultFromSuspension(emptySuspension(rootStore), 'executor-error', 'the run produced no result')
    const base = await mapDesktopClosed(finished, target)
    if (base.fault?.broken.kind === 'target.desktop-closed') {
      const last = attempts[attempts.length - 1]
      if (last !== undefined && last.status === 'faulted') last.broken = 'target.desktop-closed'
    }
    outcome = {
      ...base, rootRunId: rootStore.runId, rootDir: rootStore.dir, attempts,
      target: targetReceipt(target), baseline: baselineReport,
    }
    await rootStore.writeJson('result.json', outcome)
    return outcome
  } finally {
    const finished = outcome ?? {
      ...faultFromSuspension(emptySuspension(rootStore), 'executor-error', 'the run did not finish'),
      rootRunId: rootStore.runId, rootDir: rootStore.dir, attempts,
      target: targetReceipt(target), baseline: baselineReport,
    }
    const status: LeaseProgress['status'] = finished.status === 'completed'
      ? 'completed'
      : finished.status === 'revoked' ? 'revoked' : 'faulted'
    // Publish the receipt before releasing control so the overlay can render the
    // outcome during its linger window instead of vanishing with the lease.
    await publishProgress(runEnv, {
      leaseId: grant.leaseId,
      runId: rootStore.runId,
      status,
      step: finished.steps.length,
      total,
      op: null,
      reason: finished.fault?.broken.kind ?? null,
      at: new Date().toISOString(),
      attempt: Math.max(0, attempts.length - 1),
      maxResumes,
      phase: 'running',
    }).catch(() => {})
    await publishNotice(runEnv, grant.leaseId, null).catch(() => {})
    await releaseLease({ action: 'done', source: 'agent', env: runEnv }).catch(() => {})
  }
}

/**
 * Build an empty suspension record for an attempt that never suspended.
 * @param store Run store of the attempt.
 * @returns Synthetic record.
 */
function emptySuspension(store: RunStore): SuspendRecord {
  const at = new Date().toISOString()
  return {
    runId: store.runId, dir: store.dir, timeline: store.timelinePath, step: 0, total: 0,
    broken: [], committed: [], lastConfirmedEffect: null, steps: [], screenshots: [],
    baselineGeometry: {}, startedAt: at, finishedAt: at, durationMs: 0,
  }
}
