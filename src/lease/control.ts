/** Lease lifecycle: request, consent, hold, release, and stale cleanup. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import type { RenderLanguage } from '../i18n.ts'
import { startOverlay, stopOverlayPid, type OverlayFactory } from './overlay.ts'
import {
  acquireLock, isTerminal, newLeaseId, newLeaseState, processAlive, readControl, readDecision, readState,
  releaseLock, removeFile, readAnswer, writeDecision, writeControl, writeState, ensureLeaseDirectory, leasePaths,
  isActive, readHeartbeat, writeHeartbeat, clearNotice, clearProgress, clearInterference,
  clearInterferenceDecision, type LeasePaths, type LeasePhase, type LeaseState, type LeasePlanSummary,
  type LeaseConfirmCard,
} from './state.ts'

/** Default time the host has to answer the consent card. */
export const DEFAULT_CONSENT_MS = 45_000
/** Default time the host has to answer an approval-only card. */
export const DEFAULT_APPROVAL_MS = 60_000
/** Default time the agent may hold control after approval. */
export const DEFAULT_TTL_MS = 120_000
const POLL_MS = 100
/** Heartbeat age beyond which an active lease is considered orphaned. */
export const HEARTBEAT_STALE_MS = 5_000
/** Grace each attempt adds to the lease budget so prompt and settle lags do not trip it. */
export const LEASE_RECOVERY_MARGIN_MS = 20_000

/** Options for {@link requestLease}. */
export interface RequestOptions {
  /** One sentence naming what the host is approving. */
  reason: string
  /**
   * What the consent card shows. Omitted only for a programmatic grant inside a
   * managed desktop, where the desktop's own consent is the card.
   */
  card?: LeaseConfirmCard | null
  /**
   * Ask for an approval only: the host answers the same card, but no control is
   * handed over, no holder starts and no TTL is recorded. The capability
   * baseline acceptance uses this mode.
   */
  approvalOnly?: boolean
  /**
   * `programmatic` only inside a desktop whose own consent already covers the
   * act; the user's desktop always asks with a card.
   */
  consent?: 'card' | 'programmatic'
  ttlMs?: number
  consentMs?: number
  env?: NodeJS.ProcessEnv
  now?: Date
  pollMs?: number
  spawnOverlay?: OverlayFactory
  /** Whether the consent covers a specific submitted plan; defaults to false. */
  planBound?: boolean
  planSummary?: LeasePlanSummary
  /** Renewal allowance for resume attempts; defaults to 1. */
  maxResumes?: number
  /** Wall-clock budget from the request time; defaults to null (unbounded). */
  totalBudgetMs?: number | null
  /** Language of the consent card and the overlay; defaults to Chinese. */
  lang?: RenderLanguage
}

/** Outcome of one consent request, whatever mode it asked for. */
export interface RequestOutcome {
  /** Whether the host allowed it; control is held only when `phase` is `granted`. */
  allowed: boolean
  phase: LeasePhase
  leaseId: string
  /** `approved`, the decision source, or the timeout source. */
  reason: string
  expiresAt: string | null
  /** Who answered: `overlay`, `cli`, `host`, `desktop`, or the timeout source. */
  source: string
}

/** Options for {@link grantLease}. */
export interface GrantOptions {
  reason: string
  /** Whether the grant covers a specific submitted plan; the executor re-checks the lease before every mutation. */
  planBound?: boolean
  planSummary?: LeasePlanSummary
  /** The plan as the consent card would show it; managed desktops have no card. */
  card?: LeaseConfirmCard | null
  ttlMs: number
  maxResumes?: number
  totalBudgetMs?: number | null
  /** Where the consent came from; recorded as `grantedBy`. */
  source?: string
  env?: NodeJS.ProcessEnv
  now?: Date
}

/** Options for {@link renewLease}. */
export interface RenewOptions {
  leaseId: string
  ttlMs: number
  /** Attempt number the caller believes it is starting; must be the next one. */
  attempt: number
  env?: NodeJS.ProcessEnv
  now?: Date
}

/** Outcome of a release or decision action. */
export interface ControlOutcome {
  ok: boolean
  action: string
  phase: LeasePhase | null
  leaseId: string | null
  forced: boolean
}

/** Read-only status of the current lease. */
export interface LeaseStatus {
  active: boolean
  phase: LeasePhase | null
  leaseId: string | null
  reason: string | null
  /** Whether the lease approves a specific submitted plan. */
  planBound: boolean
  planSummary: LeasePlanSummary | null
  createdAt: string | null
  grantedAt: string | null
  expiresAt: string | null
  remainingMs: number | null
  holderPid: number | null
  overlayPid: number | null
  grantedBy: string | null
  /** Run attempt: 0 is the original plan, 1..maxResumes are resume attempts. */
  attempt: number
  /** Renewal allowance recorded on the lease. */
  maxResumes: number
  /** Wall-clock budget from `createdAt`, or null for no bound. */
  totalBudgetMs: number | null
  /** Number of TTL extensions recorded so far. */
  renewals: number
  stale: boolean
}

/** @param ms Delay in milliseconds. */
const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * Persist the terminal phase and let go of the overlay and the lock.
 * @param paths Lease paths.
 * @param state State to finalize.
 * @param phase Terminal phase.
 * @param reason Why control returned.
 */
async function finalize(paths: LeasePaths, state: LeaseState, phase: LeasePhase, reason: string): Promise<LeaseState> {
  const finished: LeaseState = {
    ...state,
    phase,
    endedAt: new Date().toISOString(),
    endReason: reason,
  }
  // Clear the transient notice before publishing the terminal phase, so anyone
  // who observes the lease as ended also observes the notice as gone. The
  // interference prompt and its answer are prompts for a run that is over.
  await clearNotice(paths)
  await clearInterference(paths)
  await clearInterferenceDecision(paths)
  await removeFile(paths.interferenceAnswerFile)
  await writeState(paths, finished)
  // A normal end (done / denied / expired) lets the overlay render the outcome
  // for its linger window and exit by itself. A revocation is the host taking
  // control back, so the banner goes away immediately.
  if (phase === 'revoked') await stopOverlayPid(finished.overlayPid)
  await releaseLock(paths)
  await removeFile(paths.decisionFile)
  await removeFile(paths.answerFile)
  await removeFile(paths.controlFile)
  await removeFile(paths.heartbeatFile)
  return finished
}

/**
 * Remove a lease whose owning processes are gone.
 * @param paths Lease paths.
 * @returns Whether something was cleaned up.
 */
export async function cleanupStaleLease(paths: LeasePaths): Promise<boolean> {
  const state = await readState(paths)
  if (state === null) { await releaseLock(paths); return false }
  if (isTerminal(state.phase)) { await releaseLock(paths); return false }
  if (!(await leaseIsStale(paths, state))) return false
  await finalize(paths, state, 'revoked', 'stale-owner')
  return true
}

/**
 * Ask the host for consent, then return after the decision.
 *
 * One function, one card. In control mode approval leaves a detached holder
 * owning the lease so the agent can work. In approval-only mode the same card
 * asks the host to approve an act that changes no desktop state: the record
 * keeps `ttlMs: 0`, starts no holder and ends `released` on allow, so neither
 * the executor nor `wl-inject` can use it. A `consent: 'programmatic'` approval
 * is only for a managed desktop whose own consent already covers the act.
 * @param options Reason, card, mode, time bounds, and overlay factory.
 * @returns The host's answer and the recorded phase.
 */
export async function requestLease(options: RequestOptions): Promise<RequestOutcome> {
  const env = options.env ?? process.env
  const paths = leasePaths(env)
  const approvalOnly = options.approvalOnly === true
  await ensureLeaseDirectory(paths)
  await cleanupStaleLease(paths)
  const previous = await readState(paths)
  if (previous !== null) await stopOverlayPid(previous.overlayPid)
  const now = options.now ?? new Date()
  const ttlMs = approvalOnly ? 0 : options.ttlMs ?? DEFAULT_TTL_MS
  const consentMs = options.consentMs ?? (approvalOnly ? DEFAULT_APPROVAL_MS : DEFAULT_CONSENT_MS)
  const leaseId = newLeaseId()
  const state = newLeaseState({
    leaseId,
    reason: options.reason,
    consentMs,
    ttlMs,
    now,
    planBound: options.planBound,
    planSummary: options.planSummary,
    card: options.card,
    approvalOnly,
    maxResumes: options.maxResumes,
    totalBudgetMs: options.totalBudgetMs,
  })
  await acquireLock(paths, { leaseId, pid: process.pid, at: now.toISOString() })
  await removeFile(paths.decisionFile)
  await removeFile(paths.answerFile)
  await removeFile(paths.controlFile)
  await clearNotice(paths)
  await clearProgress(paths)
  await clearInterference(paths)
  await clearInterferenceDecision(paths)
  await removeFile(paths.interferenceAnswerFile)
  await writeHeartbeat(paths, process.pid)
  if (approvalOnly && options.consent === 'programmatic') {
    // The desktop's own consent already covers this act; record it as approved
    // without a card, exactly like a programmatic lease inside that desktop.
    const finished = await finalize(paths, { ...state, grantedBy: 'desktop' }, 'released', 'desktop-consent')
    return { allowed: true, phase: finished.phase, leaseId, reason: 'desktop-consent', expiresAt: null, source: 'desktop' }
  }
  let overlayStarted = false
  try {
    await writeState(paths, state)
    const spawnOverlay = options.spawnOverlay ?? ((overlayPaths, overlayState) => startOverlay(overlayPaths, overlayState, { env, lang: options.lang }))
    const overlay = await spawnOverlay(paths, state)
    overlayStarted = true
    state.overlayPid = overlay.pid
    await writeState(paths, state)
    const decision = await waitForDecision(paths, state, options.pollMs ?? POLL_MS)
    if (decision.action !== 'allow') {
      const phase: LeasePhase = decision.action === 'deny' ? 'denied'
        : decision.action === 'panic' ? 'revoked' : 'expired'
      const finished = await finalize(paths, state, phase, decision.source)
      return {
        allowed: false, phase: finished.phase, leaseId,
        reason: decision.source, expiresAt: null, source: decision.source,
      }
    }
    if (approvalOnly) {
      // `grantedBy` names who answered even though no control window opens; the
      // audit trail must not lose the difference between a card and a script.
      const finished = await finalize(paths, { ...state, grantedBy: decision.source }, 'released', decision.source)
      return {
        allowed: true, phase: finished.phase, leaseId,
        reason: decision.source, expiresAt: null, source: decision.source,
      }
    }
    const grantedAt = new Date()
    // The spread keeps `planBound` / `planSummary` / `card` on the granted
    // record: approval covers the submitted plan this lease was requested for.
    const granted: LeaseState = {
      ...state,
      phase: 'granted',
      grantedBy: decision.source,
      grantedAt: grantedAt.toISOString(),
      expiresAt: new Date(grantedAt.getTime() + ttlMs).toISOString(),
      endReason: null,
    }
    await writeState(paths, granted)
    granted.holderPid = spawnHolder(env, leaseId)
    await writeState(paths, granted)
    return {
      allowed: true, phase: 'granted', leaseId,
      reason: 'approved', expiresAt: granted.expiresAt, source: decision.source,
    }
  } catch (error) {
    if (!overlayStarted) {
      await releaseLock(paths)
    } else {
      const current = await readState(paths)
      if (current !== null) await finalize(paths, current, 'revoked', 'request-failed')
      else await releaseLock(paths)
    }
    throw error
  }
}

/**
 * Grant a lease without showing a consent card.
 *
 * Only for a desktop whose consent boundary is the desktop itself (`agent` or
 * `external`): the human approved the desktop at start/attach time, and every
 * run inside it still gets a lease bound to its submitted plan and TTL. The caller
 * must have verified that the desktop record carries that consent.
 * @param options Plan binding, TTL, and source.
 * @returns A granted outcome; the detached holder owns the lease from here.
 */
export async function grantLease(options: GrantOptions): Promise<RequestOutcome> {
  const env = options.env ?? process.env
  const paths = leasePaths(env)
  await ensureLeaseDirectory(paths)
  await cleanupStaleLease(paths)
  const previous = await readState(paths)
  if (previous !== null && isActive(previous.phase)) {
    throw new HyprscopeError(ErrorCode.LEASE_ACTIVE, 'Another run on this desktop still holds control', {
      leaseId: previous.leaseId, phase: previous.phase, expiresAt: previous.expiresAt,
    })
  }
  if (previous !== null) await stopOverlayPid(previous.overlayPid)
  const now = options.now ?? new Date()
  const leaseId = newLeaseId()
  const state = newLeaseState({
    leaseId,
    reason: options.reason,
    consentMs: 0,
    ttlMs: options.ttlMs,
    now,
    planBound: options.planBound,
    planSummary: options.planSummary,
    card: options.card,
    maxResumes: options.maxResumes,
    totalBudgetMs: options.totalBudgetMs,
  })
  await acquireLock(paths, { leaseId, pid: process.pid, at: now.toISOString() })
  await removeFile(paths.decisionFile)
  await removeFile(paths.answerFile)
  await removeFile(paths.controlFile)
  await clearNotice(paths)
  await clearProgress(paths)
  await clearInterference(paths)
  await clearInterferenceDecision(paths)
  await removeFile(paths.interferenceAnswerFile)
  await writeHeartbeat(paths, process.pid)
  const grantedAt = new Date(now.getTime())
  const granted: LeaseState = {
    ...state,
    phase: 'granted',
    grantedBy: options.source ?? 'desktop',
    grantedAt: grantedAt.toISOString(),
    expiresAt: new Date(grantedAt.getTime() + options.ttlMs).toISOString(),
    endReason: null,
  }
  await writeState(paths, granted)
  granted.holderPid = spawnHolder(env, leaseId)
  await writeState(paths, granted)
  return { allowed: true, phase: 'granted', leaseId, reason: 'desktop-consent', expiresAt: granted.expiresAt, source: granted.grantedBy ?? 'desktop' }
}

/**
 * Extend a granted lease for one resume attempt, keeping the original approval.
 *
 * Renewal never re-asks the host: the lease was approved once, and the recorded
 * `maxResumes` and `totalBudgetMs` bound how far the same holder may stretch it.
 * Every rule is checked against the state on disk, and a successful renewal
 * persists the new plan digest, attempt, expiry, and lineage atomically.
 * @param options Lease identity, new plan digest, TTL, and next attempt number.
 * @returns Lease state after the renewal was persisted.
 */
export async function renewLease(options: RenewOptions): Promise<LeaseState> {
  const env = options.env ?? process.env
  const paths = leasePaths(env)
  const now = options.now ?? new Date()
  const state = await readState(paths)
  if (state === null || state.phase !== 'granted') {
    throw new HyprscopeError(ErrorCode.NO_LEASE, 'No granted lease is available to renew', {
      phase: state?.phase ?? null, leaseId: state?.leaseId ?? null,
    })
  }
  if (state.leaseId !== options.leaseId) {
    throw new HyprscopeError(ErrorCode.LEASE_MISMATCH, 'The lease changed underneath the renewal', {
      reason: 'lease-id', expected: options.leaseId, observed: state.leaseId,
    })
  }
  const expiresAt = state.expiresAt === null ? Number.NaN : Date.parse(state.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw new HyprscopeError(ErrorCode.LEASE_MISMATCH, 'The lease expired before it could be renewed', {
      reason: 'expired', expiresAt: state.expiresAt, now: now.toISOString(),
    })
  }
  // Old state files predate these fields; a missing attempt is the original run,
  // a missing allowance is the conservative default, and no renewals were recorded.
  const attempt = state.attempt ?? 0
  const maxResumes = state.maxResumes ?? 1
  if (options.attempt !== attempt + 1) {
    throw new HyprscopeError(ErrorCode.LEASE_MISMATCH, 'The renewal must start the next attempt', {
      reason: 'attempt-skip', expected: attempt + 1, observed: options.attempt,
    })
  }
  if (options.attempt > maxResumes) {
    throw new HyprscopeError(ErrorCode.LEASE_MISMATCH, 'The renewal exceeds the lease resume limit', {
      reason: 'attempt-limit', maxResumes, observed: options.attempt,
    })
  }
  const expiresAtMs = now.getTime() + options.ttlMs
  const renewals = state.renewals ?? []
  const totalBudgetMs = state.totalBudgetMs ?? null
  // Each attempt gets its own TTL on top of the lease budget plus one prompt /
  // settle margin, so consent latency cannot starve a later resume attempt.
  const renewedTtl = renewals.reduce((total, renewal) => total + renewal.ttlMs, 0) + options.ttlMs
  const marginMs = (renewals.length + 1) * LEASE_RECOVERY_MARGIN_MS
  if (totalBudgetMs !== null && renewedTtl > totalBudgetMs + marginMs) {
    throw new HyprscopeError(ErrorCode.LEASE_MISMATCH, 'The renewal exceeds the lease time budget', {
      reason: 'budget', totalBudgetMs, renewedTtl, marginMs,
    })
  }
  const renewedExpiry = new Date(expiresAtMs).toISOString()
  const renewed: LeaseState = {
    ...state,
    // Normalize the defaults so a state file written before the resume fields
    // existed is upgraded on its first renewal instead of staying partial.
    attempt: options.attempt,
    maxResumes,
    totalBudgetMs,
    ttlMs: state.ttlMs,
    expiresAt: renewedExpiry,
    renewals: [
      ...renewals,
      {
        at: now.toISOString(),
        attempt: options.attempt,
        ttlMs: options.ttlMs,
        expiresAt: renewedExpiry,
      },
    ],
  }
  await writeState(paths, renewed)
  await writeHeartbeat(paths, process.pid)
  return renewed
}

/**
 * Wait for the host's consent decision.
 * @param paths Lease paths.
 * @param state Consent state carrying the deadline.
 * @param pollMs Poll interval.
 * @returns Decision or a synthesized timeout record.
 */
async function waitForDecision(
  paths: LeasePaths,
  state: LeaseState,
  pollMs: number,
): Promise<{ action: 'allow' | 'deny' | 'panic' | 'timeout'; source: string }> {
  const deadline = Date.parse(state.consentDeadline)
  let lastHeartbeat = Date.now()
  while (Date.now() < deadline) {
    if (Date.now() - lastHeartbeat >= 500) {
      await writeHeartbeat(paths, process.pid)
      lastHeartbeat = Date.now()
    }
    // The overlay answers by writing the raw text; recording the decision and
    // ending the wait stays in this process, so a click never runs a CLI command.
    const answer = await readAnswer(paths.answerFile)
    if (answer === 'allow' || answer === 'deny') {
      await removeFile(paths.answerFile)
      return { action: answer, source: 'overlay' }
    }
    const decision = await readDecision(paths)
    if (decision !== null) {
      await removeFile(paths.decisionFile)
      return { action: decision.action, source: decision.source }
    }
    await delay(pollMs)
  }
  return { action: 'timeout', source: 'consent-timeout' }
}

/**
 * @returns Absolute path of the internal detached-holder entry module.
 */
export function holderEntry(): string {
  const source = fileURLToPath(new URL('./hold-entry.ts', import.meta.url))
  // A checkout runs the source; the emitted tree beside it has only the .js.
  return existsSync(source) ? source : fileURLToPath(new URL('./hold-entry.js', import.meta.url))
}

/**
 * Start the detached holder that keeps control until the lease ends.
 *
 * The holder is an internal module entry, never a CLI command: it is started
 * directly so the control surface exposes only what an agent actually calls.
 * @param env Session environment for the child.
 * @param leaseId Lease identity.
 * @returns Holder pid, or null when spawn failed.
 */
function spawnHolder(env: NodeJS.ProcessEnv, leaseId: string): number | null {
  try {
    const child = spawn(process.execPath, [holderEntry(), '--lease', leaseId], {
      env, detached: true, stdio: 'ignore',
    })
    child.unref()
    return child.pid ?? null
  } catch {
    return null
  }
}

/**
 * Record the host's consent decision.
 * @param options Decision, source, and wait bound.
 * @returns Action outcome; `ok` is false when no consent request is pending.
 */
export async function submitDecision(options: {
  action: 'allow' | 'deny' | 'panic'
  source?: string
  env?: NodeJS.ProcessEnv
}): Promise<ControlOutcome> {
  const env = options.env ?? process.env
  const paths = leasePaths(env)
  const state = await readState(paths)
  if (state === null || !isActive(state.phase)) {
    return { ok: false, action: options.action, phase: state?.phase ?? null, leaseId: state?.leaseId ?? null, forced: false }
  }
  if (state.phase !== 'consent') {
    throw new HyprscopeError(ErrorCode.NO_LEASE, 'The consent window has already closed', { phase: state.phase })
  }
  await writeDecision(paths, {
    leaseId: state.leaseId, action: options.action, at: new Date().toISOString(), source: options.source ?? 'host',
  })
  return { ok: true, action: options.action, phase: state.phase, leaseId: state.leaseId, forced: false }
}

/**
 * Release control from the agent side (`done`) or the host failsafe (`panic`).
 * @param options Release action, source, and wait bound.
 * @returns Outcome, including whether stale state had to be cleaned up forcibly.
 */
export async function releaseLease(options: {
  action: 'done' | 'panic'
  source?: string
  env?: NodeJS.ProcessEnv
  waitMs?: number
}): Promise<ControlOutcome> {
  const env = options.env ?? process.env
  const paths = leasePaths(env)
  const state = await readState(paths)
  if (state === null || isTerminal(state.phase)) {
    return { ok: false, action: options.action, phase: state?.phase ?? null, leaseId: state?.leaseId ?? null, forced: false }
  }
  const source = options.source ?? (options.action === 'done' ? 'agent' : 'host')
  if (state.phase === 'consent') {
    await writeDecision(paths, {
      leaseId: state.leaseId,
      action: options.action === 'panic' ? 'panic' : 'deny',
      at: new Date().toISOString(),
      source,
    })
  } else {
    await writeControl(paths, { leaseId: state.leaseId, action: options.action, at: new Date().toISOString(), source })
  }
  const waitMs = options.waitMs ?? 5000
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const current = await readState(paths)
    if (current === null || isTerminal(current.phase)) {
      return { ok: true, action: options.action, phase: current?.phase ?? null, leaseId: state.leaseId, forced: false }
    }
    await delay(50)
  }
  await finalize(paths, state, options.action === 'done' ? 'released' : 'revoked', `${source}-forced`)
  return { ok: true, action: options.action, phase: options.action === 'done' ? 'released' : 'revoked', leaseId: state.leaseId, forced: true }
}

/**
 * Detached holder loop: keeps the lease alive until `done`, `panic`, or TTL expiry.
 * @param options Lease identity and optional polling override.
 * @returns Completion after control returned.
 */
export async function holdLease(options: {
  leaseId: string
  env?: NodeJS.ProcessEnv
  pollMs?: number
}): Promise<void> {
  const env = options.env ?? process.env
  const paths = leasePaths(env)
  const pollMs = options.pollMs ?? POLL_MS
  let announced = false
  let lastHeartbeat = 0
  while (true) {
    const state = await readState(paths)
    if (state === null || state.leaseId !== options.leaseId || isTerminal(state.phase)) return
    if (!announced) {
      await writeState(paths, { ...state, holderPid: process.pid })
      announced = true
    }
    if (Date.now() - lastHeartbeat >= 500) {
      await writeHeartbeat(paths, process.pid)
      lastHeartbeat = Date.now()
    }
    const control = await readControl(paths)
    if (control !== null && control.leaseId === state.leaseId) {
      await finalize(paths, state, control.action === 'done' ? 'released' : 'revoked', control.source)
      return
    }
    const expiry = state.expiresAt === null ? null : Date.parse(state.expiresAt)
    if (expiry !== null && Date.now() >= expiry) {
      await finalize(paths, state, 'expired', 'ttl')
      return
    }
    await delay(pollMs)
  }
}

/**
 * Decide whether an active lease has lost its owner.
 * @param paths Lease paths.
 * @param state Current state.
 * @returns Whether the heartbeat or owner process is gone.
 */
async function leaseIsStale(paths: LeasePaths, state: LeaseState): Promise<boolean> {
  if (!isActive(state.phase)) return false
  const heartbeat = await readHeartbeat(paths)
  if (heartbeat !== null) return Date.now() - Date.parse(heartbeat.at) > HEARTBEAT_STALE_MS
  const ownerPid = state.phase === 'granted' ? state.holderPid : state.requesterPid
  return !processAlive(ownerPid)
}

/**
 * Read the current lease status without changing it.
 * @param env Environment to read.
 * @returns Lease status.
 */
export async function leaseStatus(env: NodeJS.ProcessEnv = process.env): Promise<LeaseStatus> {
  const paths = leasePaths(env)
  const state = await readState(paths)
  if (state === null) {
    return {
      active: false, phase: null, leaseId: null, reason: null, planBound: false, planSummary: null,
      createdAt: null, grantedAt: null, expiresAt: null,
      remainingMs: null, holderPid: null, overlayPid: null, grantedBy: null,
      attempt: 0, maxResumes: 0, totalBudgetMs: null, renewals: 0, stale: false,
    }
  }
  const deadline = state.phase === 'consent'
    ? Date.parse(state.consentDeadline)
    : state.expiresAt === null ? null : Date.parse(state.expiresAt)
  return {
    active: isActive(state.phase),
    phase: state.phase,
    leaseId: state.leaseId,
    reason: state.reason,
    planBound: state.planBound === true,
    planSummary: state.planSummary ?? null,
    createdAt: state.createdAt,
    grantedAt: state.grantedAt,
    expiresAt: state.expiresAt,
    remainingMs: deadline === null ? null : Math.max(0, deadline - Date.now()),
    holderPid: state.holderPid,
    overlayPid: state.overlayPid,
    grantedBy: state.grantedBy,
    attempt: state.attempt ?? 0,
    maxResumes: state.maxResumes ?? 1,
    totalBudgetMs: state.totalBudgetMs ?? null,
    renewals: (state.renewals ?? []).length,
    stale: await leaseIsStale(paths, state),
  }
}
