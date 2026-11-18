/** Lease state files: one control handoff, readable by every local process. */
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ErrorCode, HyprscopeError } from '../errors.ts'

/** Lease lifecycle phase. */
export type LeasePhase = 'consent' | 'granted' | 'released' | 'denied' | 'expired' | 'revoked'

/** Phases that no longer hold control. */
export type TerminalPhase = Extract<LeasePhase, 'released' | 'denied' | 'expired' | 'revoked'>

/** Plan preview the host consents to; the approval covers this one submitted plan. */
export interface LeasePlanSummary {
  steps: number
  ops: string[]
  workspace: string | null
  summary: string | null
}

/**
 * What a consent card asks the host to approve.
 *
 * There is one card. A plan lease shows what the submitted plan does; an
 * approval-only request shows the facts of an act that changes no desktop state
 * (today: accepting the capability baseline). Both are answered through the same
 * decision file and rendered by the same overlay card; only the mode differs.
 */
export interface LeaseConfirmCard {
  /** Card heading, such as `hyprscope · 接受能力基线`. */
  title: string
  /** One line per fact the host should read before answering. */
  lines: string[]
  /** Label of the allow button. */
  acceptLabel: string
  /** Label of the deny button. */
  denyLabel: string
}

/** One TTL extension recorded when a granted lease resumes as a new attempt. */
export interface LeaseRenewal {
  at: string
  attempt: number
  ttlMs: number
  expiresAt: string
}

/** Persisted state shared by requester, holder, overlay, and the panic shortcut. */
export interface LeaseState {
  version: 1
  leaseId: string
  phase: LeasePhase
  reason: string
  /** Whether the host approved a submitted plan; `request` leases are not bound. */
  planBound: boolean
  planSummary: LeasePlanSummary | null
  ttlMs: number
  createdAt: string
  consentDeadline: string
  grantedAt: string | null
  expiresAt: string | null
  endedAt: string | null
  endReason: string | null
  requesterPid: number | null
  holderPid: number | null
  overlayPid: number | null
  /** Who approved the lease: `overlay`, `cli`, `host`, or another source string. */
  grantedBy: string | null
  /** Run attempt: 0 is the originally approved plan, 1..maxResumes are resumes. */
  attempt: number
  /** How many renewals the lease may record before the holder must end it. */
  maxResumes: number
  /** Wall-clock budget measured from `createdAt`, or null for no budget bound. */
  totalBudgetMs: number | null
  /** TTL extensions granted so far, oldest first. */
  renewals: LeaseRenewal[]
  /** What the consent card shows; null when the lease was requested without one. */
  card?: LeaseConfirmCard | null
  /**
   * Whether this consent only asks for an approval and never hands over control.
   * An approval-only record keeps `ttlMs: 0`, starts no holder, ends `released`
   * on allow and never reaches `granted`, so neither the executor nor
   * `wl-inject` can use it. `planSummary` stays the compact machine summary.
   */
  approvalOnly?: boolean
}

/** File name of the transient interference notice under one lease directory. */
export const NOTICE_FILE = 'notice.json'

/** File name of the execution progress the overlay renders while a plan runs. */
export const PROGRESS_FILE = 'progress.json'

/** File name of the blocking interference prompt the overlay renders. */
export const INTERFERENCE_FILE = 'interference.json'

/** File name of the human's answer to the interference prompt. */
export const INTERFERENCE_DECISION_FILE = 'interference-decision.json'

/** File name of the overlay's raw consent answer (`allow` or `deny`). */
export const CONSENT_ANSWER_FILE = 'answer'

/** File name of the overlay's raw interference answer (`continue` or `abort`). */
export const INTERFERENCE_ANSWER_FILE = 'interference-answer'

/** Absolute paths owned by one runtime directory. */
export interface LeasePaths {
  dir: string
  stateFile: string
  decisionFile: string
  /** Raw consent answer the overlay writes; the requester turns it into a decision. */
  answerFile: string
  controlFile: string
  heartbeatFile: string
  noticeFile: string
  progressFile: string
  interferenceFile: string
  interferenceDecisionFile: string
  /** Raw interference answer the overlay writes; the run turns it into a decision. */
  interferenceAnswerFile: string
  lockFile: string
  overlayLog: string
}

/** Liveness record refreshed by the consent requester and the lease holder. */
export interface HeartbeatRecord {
  pid: number
  at: string
}

/** A consent decision written by the overlay or the host. */
export interface DecisionRecord {
  leaseId: string
  action: 'allow' | 'deny' | 'panic'
  at: string
  source: string
}

/** A release request written by the agent or the host. */
export interface ControlRecord {
  leaseId: string
  action: 'done' | 'panic'
  at: string
  source: string
}

/** Transient interference notice rendered while a granted lease is correcting course. */
export interface LeaseNotice {
  leaseId: string
  text: string
  at: string
  expiresAt: string
}

/** Progress of the plan running under one lease, rendered by the overlay. */
export interface LeaseProgress {
  leaseId: string
  runId: string
  status: 'running' | 'completed' | 'faulted' | 'revoked'
  step: number
  total: number
  op: string | null
  reason: string | null
  at: string
  /** Run attempt being reported; 0 is the original plan, absent on older records. */
  attempt?: number
  /** Renewal allowance the attempt counts against; absent on older records. */
  maxResumes?: number
  /** `recovering` while an interference prompt is pending, `running` otherwise. */
  phase?: 'running' | 'recovering'
}

/** A blocking question the executor asks when a recoverable interference appears. */
export interface LeaseInterference {
  leaseId: string
  runId: string
  /** Unique prompt id written by the executor; the decision must echo it. */
  id: string
  /** 1-based step number the prompt belongs to. */
  step: number
  total: number
  /** Predicate kind, or `foreign-event` for a compositor-level change. */
  kind: string
  detail: string
  at: string
  /** ISO deadline; the executor aborts on its own when it passes. */
  expiresAt: string
  /** 1-based recovery attempt the prompt would start (next attempt). */
  attempt?: number
  /** Renewal allowance the attempt counts against; absent on older records. */
  maxResumes?: number
  /** Wall-clock budget reported with the prompt; absent when unbounded. */
  budgetMs?: number
  /** Predicate violations that made the run recoverable, for the overlay. */
  broken?: { kind: string; detail: string; expected?: unknown; observed?: unknown }[]
}

/** The human's answer to one {@link LeaseInterference} prompt. */
export interface InterferenceDecision {
  id: string
  decision: 'continue' | 'abort'
  at: string
  source: string
}

/** Lock-file owner recorded when a lease starts. */
export interface LeaseOwner {
  leaseId: string
  pid: number
  at: string
}

const TERMINAL_PHASES: readonly TerminalPhase[] = ['released', 'denied', 'expired', 'revoked']

/**
 * @param phase Lease phase.
 * @returns Whether control has already returned to the host.
 */
export function isTerminal(phase: LeasePhase): phase is TerminalPhase {
  return (TERMINAL_PHASES as readonly string[]).includes(phase)
}

/**
 * @param phase Lease phase.
 * @returns Whether the lease is between consent and release.
 */
export function isActive(phase: LeasePhase): boolean {
  return phase === 'consent' || phase === 'granted'
}

/**
 * Resolve the directory that holds lease state.
 *
 * State cannot live under `XDG_RUNTIME_DIR`: the Harness file sandbox may mount it
 * read-only, while the compositor-launched panic command must reach the same files.
 * @param env Environment to read.
 * @returns Absolute state directory.
 */
export function leaseDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state')
  const signature = env.HYPRSCOPE_LEASE_SIGNATURE
  // A nested desktop gets its own lease directory: closing it must not release a
  // lease the user's desktop is holding, and two desktops may run plans at once.
  if (signature !== undefined && signature !== '') {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(signature)) {
      throw new HyprscopeError(ErrorCode.USAGE, `Instance signature ${signature} is not a safe directory name`, { signature })
    }
    return join(base, 'hyprlease', signature)
  }
  return join(base, 'hyprlease')
}

/**
 * @param env Environment to read.
 * @returns Absolute paths under {@link leaseDirectory}.
 */
export function leasePaths(env: NodeJS.ProcessEnv = process.env): LeasePaths {
  const dir = leaseDirectory(env)
  return {
    dir,
    stateFile: join(dir, 'state.json'),
    decisionFile: join(dir, 'decision.json'),
    answerFile: join(dir, CONSENT_ANSWER_FILE),
    controlFile: join(dir, 'control.json'),
    heartbeatFile: join(dir, 'heartbeat.json'),
    noticeFile: join(dir, NOTICE_FILE),
    progressFile: join(dir, PROGRESS_FILE),
    interferenceFile: join(dir, INTERFERENCE_FILE),
    interferenceDecisionFile: join(dir, INTERFERENCE_DECISION_FILE),
    interferenceAnswerFile: join(dir, INTERFERENCE_ANSWER_FILE),
    lockFile: join(dir, 'lease.lock'),
    overlayLog: join(dir, 'overlay.log'),
  }
}

/**
 * @returns A fresh opaque lease id.
 */
export function newLeaseId(): string {
  return randomUUID()
}

/** Options for {@link newLeaseState}. */
export interface NewLeaseOptions {
  leaseId: string
  reason: string
  consentMs: number
  ttlMs: number
  now: Date
  requesterPid?: number | null
  /** Whether the consent covers a specific submitted plan. */
  planBound?: boolean
  planSummary?: LeasePlanSummary | null
  /** Renewal allowance for resume attempts; defaults to 1. */
  maxResumes?: number
  /** Wall-clock budget from `createdAt`; defaults to null (unbounded). */
  totalBudgetMs?: number | null
  /** What the consent card shows, for a card or an approval-only request. */
  card?: LeaseConfirmCard | null
  /** Whether this consent only asks for an approval, not a handoff of control. */
  approvalOnly?: boolean
}

/**
 * Build the initial `consent` record.
 * @param options Lease identity and consent window.
 * @returns New state record.
 */
export function newLeaseState(options: NewLeaseOptions): LeaseState {
  const consentDeadline = new Date(options.now.getTime() + options.consentMs).toISOString()
  return {
    version: 1,
    leaseId: options.leaseId,
    phase: 'consent',
    reason: options.reason,
    planBound: options.planBound === true,
    planSummary: options.planSummary ?? null,
    ttlMs: options.ttlMs,
    createdAt: options.now.toISOString(),
    consentDeadline,
    grantedAt: null,
    expiresAt: null,
    endedAt: null,
    endReason: null,
    requesterPid: options.requesterPid ?? process.pid,
    holderPid: null,
    overlayPid: null,
    grantedBy: null,
    attempt: 0,
    maxResumes: options.maxResumes ?? 1,
    totalBudgetMs: options.totalBudgetMs ?? null,
    renewals: [],
    card: options.card ?? null,
    approvalOnly: options.approvalOnly === true,
  }
}

/**
 * Write JSON through a temporary file and rename so readers never see half a record.
 * @param path Destination path.
 * @param value JSON-serializable value.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

/**
 * Read one JSON record.
 * @param path Source path.
 * @returns Parsed record, or null when the file does not exist.
 */
export async function readJson<T>(path: string): Promise<T | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return JSON.parse(text) as T
}

/**
 * Remove a file if it exists.
 * @param path Target path.
 */
export async function removeFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * Ensure the state directory exists with private permissions.
 * @param paths Lease paths.
 */
export async function ensureLeaseDirectory(paths: LeasePaths): Promise<void> {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 })
}

/**
 * @param paths Lease paths.
 * @returns Current state record, or null.
 */
export function readState(paths: LeasePaths): Promise<LeaseState | null> {
  return readJson<LeaseState>(paths.stateFile)
}

/**
 * @param paths Lease paths.
 * @param state State to persist.
 */
export function writeState(paths: LeasePaths, state: LeaseState): Promise<void> {
  return writeJsonAtomic(paths.stateFile, state)
}

/**
 * Claim the single lease slot.
 * @param paths Lease paths.
 * @param owner Owner identity.
 * @returns Completion after the lock exists.
 */
export async function acquireLock(paths: LeasePaths, owner: LeaseOwner): Promise<void> {
  await ensureLeaseDirectory(paths)
  let handle
  try {
    handle = await open(paths.lockFile, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const current = await readLock(paths)
      throw new HyprscopeError(ErrorCode.LEASE_ACTIVE, 'Another control lease already exists', {
        leaseId: current?.leaseId ?? null, owner: current,
      })
    }
    throw error
  }
  try {
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`)
  } finally {
    await handle.close()
  }
}

/**
 * @param paths Lease paths.
 * @returns Current lock owner, or null when unlocked.
 */
export function readLock(paths: LeasePaths): Promise<LeaseOwner | null> {
  return readJson<LeaseOwner>(paths.lockFile)
}

/**
 * Release the lease slot.
 * @param paths Lease paths.
 */
export function releaseLock(paths: LeasePaths): Promise<void> {
  return removeFile(paths.lockFile)
}

/**
 * @param paths Lease paths.
 * @returns Pending consent decision, or null.
 */
export function readDecision(paths: LeasePaths): Promise<DecisionRecord | null> {
  return readJson<DecisionRecord>(paths.decisionFile)
}

/**
 * Read one raw answer the overlay wrote for a card.
 *
 * The overlay writes the answer bytes only; the waiting tool records the decision
 * itself, so a click never spawns a CLI process.
 * @param file Absolute answer path.
 * @returns Trimmed answer text, or null when the file is absent or empty.
 */
export async function readAnswer(file: string): Promise<string | null> {
  try {
    const text = (await readFile(file, 'utf8')).trim()
    return text === '' ? null : text
  } catch {
    return null
  }
}

/**
 * @param paths Lease paths.
 * @param decision Decision to persist.
 */
export function writeDecision(paths: LeasePaths, decision: DecisionRecord): Promise<void> {
  return writeJsonAtomic(paths.decisionFile, decision)
}

/**
 * @param paths Lease paths.
 * @returns Pending release request, or null.
 */
export function readControl(paths: LeasePaths): Promise<ControlRecord | null> {
  return readJson<ControlRecord>(paths.controlFile)
}

/**
 * @param paths Lease paths.
 * @param control Release request to persist.
 */
export function writeControl(paths: LeasePaths, control: ControlRecord): Promise<void> {
  return writeJsonAtomic(paths.controlFile, control)
}

/**
 * Publish the transient notice the overlay shows beside a granted lease.
 *
 * The directory is created first so a plan executor can publish a notice even
 * when it did not create the lease itself.
 * @param paths Lease paths.
 * @param notice Notice to persist.
 */
export async function writeNotice(paths: LeasePaths, notice: LeaseNotice): Promise<void> {
  await ensureLeaseDirectory(paths)
  await writeJsonAtomic(paths.noticeFile, notice)
}

/**
 * @param paths Lease paths.
 * @returns Current notice, or null when none was published.
 */
export function readNotice(paths: LeasePaths): Promise<LeaseNotice | null> {
  return readJson<LeaseNotice>(paths.noticeFile)
}

/**
 * Remove the published notice if it exists.
 * @param paths Lease paths.
 */
export function clearNotice(paths: LeasePaths): Promise<void> {
  return removeFile(paths.noticeFile)
}

/**
 * Publish execution progress for the overlay.
 *
 * Like {@link writeNotice}, this creates the lease directory first so the plan
 * executor can report progress without owning the lease lifecycle.
 * @param paths Lease paths.
 * @param progress Progress record.
 */
export async function writeProgress(paths: LeasePaths, progress: LeaseProgress): Promise<void> {
  await ensureLeaseDirectory(paths)
  await writeJsonAtomic(paths.progressFile, progress)
}

/**
 * @param paths Lease paths.
 * @returns Current progress, or null when no plan is being reported.
 */
export function readProgress(paths: LeasePaths): Promise<LeaseProgress | null> {
  return readJson<LeaseProgress>(paths.progressFile)
}

/**
 * Remove the progress record if it exists.
 * @param paths Lease paths.
 */
export function clearProgress(paths: LeasePaths): Promise<void> {
  return removeFile(paths.progressFile)
}

/**
 * Publish the blocking interference prompt the overlay renders.
 *
 * Like {@link writeNotice}, this creates the lease directory first so the plan
 * executor can publish a prompt without owning the lease lifecycle.
 * @param paths Lease paths.
 * @param interference Prompt to persist.
 */
export async function writeInterference(paths: LeasePaths, interference: LeaseInterference): Promise<void> {
  await ensureLeaseDirectory(paths)
  await writeJsonAtomic(paths.interferenceFile, interference)
}

/**
 * @param paths Lease paths.
 * @returns Pending interference prompt, or null when none is published.
 */
export function readInterference(paths: LeasePaths): Promise<LeaseInterference | null> {
  return readJson<LeaseInterference>(paths.interferenceFile)
}

/**
 * Remove the published interference prompt if it exists.
 * @param paths Lease paths.
 */
export function clearInterference(paths: LeasePaths): Promise<void> {
  return removeFile(paths.interferenceFile)
}

/**
 * Publish the human's answer to an interference prompt.
 * @param paths Lease paths.
 * @param decision Answer to persist.
 */
export async function writeInterferenceDecision(paths: LeasePaths, decision: InterferenceDecision): Promise<void> {
  await ensureLeaseDirectory(paths)
  await writeJsonAtomic(paths.interferenceDecisionFile, decision)
}

/**
 * @param paths Lease paths.
 * @returns Latest interference answer, or null when none was written.
 */
export function readInterferenceDecision(paths: LeasePaths): Promise<InterferenceDecision | null> {
  return readJson<InterferenceDecision>(paths.interferenceDecisionFile)
}

/**
 * Remove the interference answer if it exists.
 * @param paths Lease paths.
 */
export function clearInterferenceDecision(paths: LeasePaths): Promise<void> {
  return removeFile(paths.interferenceDecisionFile)
}

/**
 * Refresh the holder liveness record.
 * @param paths Lease paths.
 * @param pid Process writing the heartbeat.
 */
export function writeHeartbeat(paths: LeasePaths, pid: number): Promise<void> {
  return writeJsonAtomic(paths.heartbeatFile, { pid, at: new Date().toISOString() } satisfies HeartbeatRecord)
}

/**
 * @param paths Lease paths.
 * @returns Latest heartbeat record, or null.
 */
export function readHeartbeat(paths: LeasePaths): Promise<HeartbeatRecord | null> {
  return readJson<HeartbeatRecord>(paths.heartbeatFile)
}

export { processAlive } from '../process.ts'
