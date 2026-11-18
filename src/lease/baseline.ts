/**
 * `hyprscope control baseline`: measure this machine and ask the host to accept the result.
 *
 * Two commands live here:
 * - `--probe` asks the host to let the probe take the desktop briefly for
 *   measurement (that lease card belongs to the probe), then writes either a
 *   pending draft or, when the new effective set is a subset of the accepted
 *   one, narrows the accepted file in place. A widening result is followed by
 *   the acceptance card in the same call: the host's click is the only way a
 *   baseline becomes readable by the engine, and no CLI entry can answer it;
 * - `--show` reads the accepted file and any pending draft without writing.
 */
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import {
  baselinePaths, computeState, effectiveCapabilities, parseBaselineDocument, readBaseline, writeBaselineFile,
} from '../compat/baseline.ts'
import { CAPABILITY_IDS, capabilityLevel } from '../compat/catalog.ts'
import { runProbe } from '../compat/probe.ts'
import type {
  BaselineApproval, BaselineDocument, BaselineRevision, BaselineState, CapabilityEntry, CapabilityId,
  CapabilityLevel, CapabilityStatus, EvidenceLevel,
} from '../compat/types.ts'
import type { Session } from '../types.ts'
import type { DesktopTarget } from '../desktop/types.ts'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import { tr, type RenderLanguage } from '../i18n.ts'
import { requestLease } from './control.ts'
import type { LeaseConfirmCard } from './state.ts'

/** One capability as a command report prints it. */
export interface BaselineLine {
  id: CapabilityId
  level: CapabilityLevel
  status: CapabilityStatus
  evidence: EvidenceLevel
  /** Reason when unsupported or unknown. */
  detail: string | null
}

/** Options shared by the three baseline commands. */
export interface BaselineOptions {
  env?: NodeJS.ProcessEnv
  now?: () => Date
  /** Instance signature; absent means the machine-wide baseline for the user's desktop. */
  signature?: string | null
  /** Selector the baseline belongs to; only used for the command printed to the human. */
  target?: DesktopTarget
  /** Language of the confirmation card and overlay; defaults to Chinese. */
  lang?: RenderLanguage
}

/** Options for {@link probeBaseline}. */
export interface BaselineProbeOptions extends BaselineOptions {
  /** How long the lease card waits for the host. */
  consentMs?: number
  /** Measure without touching the desktop. */
  readOnly?: boolean
  /** Session to measure; resolved by the caller from the desktop target. */
  session?: Session
  /** Generated-config hash the baseline should record. */
  configHash?: string | null
  /** Programmatic consent inside a desktop the human already approved. */
  consent?: 'card' | 'programmatic'
}

/** Options for {@link showBaseline}. */
export interface BaselineShowOptions extends BaselineOptions {
  /** Compare the pending draft with the accepted baseline. */
  diff?: boolean
}

/** One answer to the baseline confirmation card. */
export interface BaselineConfirmation {
  approved: boolean
  /** Who answered; `overlay` means the confirmation card, `desktop` a managed desktop's own consent. */
  source: string
  /** Recorded terminal phase: released, denied, expired, or revoked. */
  phase: string
}

/** What an accept asks the host to confirm. */
export interface BaselineConfirmRequest {
  reason: string
  card: LeaseConfirmCard
  /** `programmatic` only for a desktop whose own consent already covers the act. */
  consent: 'card' | 'programmatic'
  env: NodeJS.ProcessEnv
}

/** Options for {@link acceptBaseline}. */
export interface BaselineAcceptOptions extends BaselineOptions {
  /** How long the confirmation card waits for the host. */
  consentMs?: number
  /** Injectable confirmation; tests and headless callers answer directly. */
  confirm?: (request: BaselineConfirmRequest) => Promise<BaselineConfirmation>
}

/** Result of `baseline --probe`. */
export interface BaselineProbeReport {
  probeId: string
  mode: 'full' | 'read-only'
  /**
   * `narrowed` writes the accepted file in place, `accepted` records the host's
   * answer to the card this probe showed, and `pending` keeps the draft because
   * the card was denied or expired.
   */
  applied: 'narrowed' | 'pending' | 'accepted'
  /** File that was written. */
  path: string
  state: BaselineState
  supported: BaselineLine[]
  unsupported: BaselineLine[]
  unknown: BaselineLine[]
  evidence: { file: string; sha256: string }
  /** Effective-set difference against the accepted baseline. */
  diff: { acceptedState: BaselineState | null; added: CapabilityId[]; removed: CapabilityId[] }
  warnings: string[]
  /** The human answer, when this probe showed the confirmation card. */
  confirmation: { approved: boolean; phase: string; source: string } | null
  /** The accepted baseline, when the host approved the card this probe showed. */
  accept: BaselineAcceptReport | null
}

/** Result recorded when the probe's confirmation card is approved. */
export interface BaselineAcceptReport {
  accepted: true
  path: string
  state: BaselineState
  approvedAt: string
  approvedBy: 'human'
  /** Where the confirmation came from: the overlay card, a managed desktop, or a direct call. */
  source: BaselineApproval['source']
  evidenceSha256: string | null
  /** Capabilities the engine may now use. */
  usable: CapabilityId[]
  /** Code-degraded capabilities the accepted baseline does not grant. */
  degraded: CapabilityId[]
  /** Required capabilities the accepted baseline does not measure. */
  missingRequired: CapabilityId[]
  warnings: string[]
}

/** The pending draft, as `--show` describes it. */
export interface BaselinePendingSummary {
  present: boolean
  path: string
  state: BaselineState | null
  probeId: string | null
  evidenceSha256: string | null
}

/** Result of `baseline --show`. */
export interface BaselineShowReport {
  present: boolean
  state: BaselineState | null
  path: string
  /** Why no accepted baseline is readable, when `present` is false. */
  reason: string | null
  approvedAt: string | null
  compositorVersion: string | null
  effective: CapabilityId[]
  degraded: CapabilityId[]
  missingRequired: CapabilityId[]
  warnings: string[]
  pending: BaselinePendingSummary | null
  /** Only present with `--diff`; compares the pending draft with the accepted file. */
  diff: {
    added: CapabilityId[]
    removed: CapabilityId[]
    acceptedState: BaselineState | null
    pendingState: BaselineState | null
  } | null
}

/** One pending draft read from disk. */
interface PendingDraft {
  path: string
  document: BaselineDocument | null
  warnings: string[]
}

/** @param value Text. @param width Minimum width. @returns Padded text. */
function pad(value: string, width: number): string {
  return value.length >= width ? value : value.padEnd(width)
}

/**
 * @param effective Effective capability set.
 * @returns Ids in catalog order.
 */
function ordered(effective: ReadonlySet<CapabilityId>): CapabilityId[] {
  return CAPABILITY_IDS.filter(id => effective.has(id))
}

/**
 * List the ids of one level that the effective set does not grant.
 * @param level Level to select.
 * @param effective Effective capability set.
 * @returns Ids in catalog order.
 */
function levelIds(level: CapabilityLevel, effective: ReadonlySet<CapabilityId>): CapabilityId[] {
  return CAPABILITY_IDS.filter(id => capabilityLevel(id) === level && !effective.has(id))
}

/**
 * Turn every catalog id into one report line.
 * @param capabilities Entries keyed by id.
 * @returns Lines in catalog order, one per capability.
 */
function linesFor(capabilities: Record<string, CapabilityEntry>): BaselineLine[] {
  return CAPABILITY_IDS.map(id => {
    const entry = capabilities[id]
    return {
      id,
      level: capabilityLevel(id),
      status: entry?.status ?? 'unknown',
      evidence: entry?.evidence ?? 'unknown',
      detail: entry?.detail ?? null,
    }
  })
}

/**
 * Read the pending draft without treating it as an accepted baseline.
 * @param env Environment that owns the state directory.
 * @returns Draft record, or null when no draft exists.
 */
async function readPending(env: NodeJS.ProcessEnv, signature: string | null): Promise<PendingDraft | null> {
  const path = baselinePaths(env, { signature }).pendingFile
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return null
    return { path, document: null, warnings: [`the pending draft could not be read (${code ?? 'unknown error'})`] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { path, document: null, warnings: ['the pending draft is not JSON'] }
  }
  const warnings: string[] = []
  return { path, document: parseBaselineDocument(parsed, warnings), warnings }
}

/**
 * Measure this machine and write a draft, or narrow the accepted baseline.
 *
 * Widening — any capability the accepted baseline does not already grant — only
 * produces a pending draft: what a human approves is the evidence hash, and the
 * probe must never approve itself.
 * @param options Environment, consent bound, and clock.
 * @returns Report for the acceptance card.
 */
export async function probeBaseline(options: BaselineProbeOptions = {}): Promise<BaselineProbeReport> {
  const env = options.env ?? process.env
  const now = options.now ?? ((): Date => new Date())
  const signature = options.signature ?? null
  const outcome = await runProbe({
    env,
    consentMs: options.consentMs,
    readOnly: options.readOnly,
    lang: options.lang,
    now,
    session: options.session,
    configHash: options.configHash,
    consent: options.consent,
  })
  const paths = baselinePaths(env, { signature })
  const accepted = await readBaseline(env, { signature })
  const effective = effectiveCapabilities(outcome.document.capabilities)
  const acceptedEffective = accepted.loaded?.effective ?? new Set<CapabilityId>()
  const added = ordered(effective).filter(id => !acceptedEffective.has(id))
  const removed = ordered(acceptedEffective).filter(id => !effective.has(id))
  // "advertised -> measured" is a widening too: the capability is already usable,
  // but its semantics were never verified, so it needs a fresh human acceptance.
  const upgraded = ordered(effective).filter((id) => {
    const before = accepted.loaded?.document.capabilities[id]?.evidence
    return before !== undefined && before !== 'measured'
      && outcome.document.capabilities[id]?.evidence === 'measured'
  })
  const history = accepted.loaded?.document.revisions ?? []
  const lines = linesFor(outcome.document.capabilities)
  const diff = {
    acceptedState: accepted.loaded?.state ?? null,
    added,
    removed,
  }
  const base = {
    probeId: outcome.probeId,
    mode: outcome.document.probe.mode,
    state: outcome.document.state,
    supported: lines.filter(line => line.status === 'supported'),
    unsupported: lines.filter(line => line.status === 'unsupported'),
    unknown: lines.filter(line => line.status === 'unknown'),
    evidence: { file: outcome.evidenceFile, sha256: outcome.evidenceSha256 },
    diff,
    warnings: [...outcome.warnings],
    confirmation: null,
    accept: null,
  }
  if (upgraded.length > 0) {
    base.warnings.push(`evidence improved to measured for ${upgraded.join(', ')}; a fresh acceptance is required`)
  }
  if (accepted.loaded !== null && added.length === 0 && upgraded.length === 0) {
    const revision: BaselineRevision = {
      kind: 'narrow',
      at: now().toISOString(),
      evidenceSha256: outcome.evidenceSha256,
    }
    const narrowed: BaselineDocument = {
      ...outcome.document,
      approval: accepted.loaded.document.approval,
      revisions: [...history, revision],
    }
    await writeBaselineFile(paths.baselineFile, narrowed)
    // A stale draft from an earlier probe is superseded by the narrowed file.
    await rm(paths.pendingFile, { force: true })
    return { ...base, applied: 'narrowed', path: paths.baselineFile, state: narrowed.state }
  }
  const pending: BaselineDocument = {
    ...outcome.document,
    approval: null,
    ...(history.length > 0 ? { revisions: history } : {}),
  }
  await writeBaselineFile(paths.pendingFile, pending)
  return { ...base, applied: 'pending', path: paths.pendingFile, state: pending.state }
}

/**
 * Build the card that asks the host to accept one measured verdict.
 * @param draft Pending draft.
 * @param state Verdict the draft computes to.
 * @param lang Render language.
 * @returns Card content for the overlay.
 */
function confirmationCard(draft: BaselineDocument, state: BaselineState, lang: RenderLanguage): LeaseConfirmCard {
  let required = 0
  let requiredMeasured = 0
  let optionalMeasured = 0
  let optionalOpen = 0
  for (const id of CAPABILITY_IDS) {
    const entry = draft.capabilities[id]
    const measured = entry?.evidence === 'measured' && entry.status === 'supported'
    if (capabilityLevel(id) === 'required') {
      required += 1
      if (measured) requiredMeasured += 1
    } else if (capabilityLevel(id) === 'optional') {
      if (measured) optionalMeasured += 1
      else optionalOpen += 1
    }
  }
  const sha = draft.evidence?.sha256 ?? null
  const lines = [
    tr(lang, `状态：${state}`, `Status: ${state}`),
    tr(lang, `必需能力：${requiredMeasured}/${required} 已实测`,
      `Required capabilities: ${requiredMeasured}/${required} measured`),
    tr(lang, `可选能力：${optionalMeasured} 项已实测，${optionalOpen} 项未实测`,
      `Optional capabilities: ${optionalMeasured} measured, ${optionalOpen} unmeasured`),
    sha === null
      ? tr(lang, '证据：未记录', 'Evidence: not recorded')
      : tr(lang,
        `证据：sha256 ${sha.slice(0, 12)}…（探测 ${draft.probe.id.slice(0, 8)} · ${draft.probe.mode} · ${draft.probe.durationMs}ms）`,
        `Evidence: sha256 ${sha.slice(0, 12)}… (probe ${draft.probe.id.slice(0, 8)} · ${draft.probe.mode} · ${draft.probe.durationMs}ms)`),
    tr(lang, '接受后，agent 每次操控桌面仍需要单独的计划同意卡。',
      'Accepting this grants no desktop control: every run still asks for its own plan card.'),
  ]
  if (state !== 'usable') {
    lines.splice(1, 0, tr(lang, `注意：基线状态为 ${state}，接受后控制仍不可用。`,
      `Note: the baseline state is ${state}; control stays unavailable after accepting.`))
  }
  return {
    title: tr(lang, 'hyprscope · 接受能力基线', 'hyprscope · Accept the capability baseline'),
    lines,
    acceptLabel: tr(lang, '允许并接受', 'Allow and accept'),
    denyLabel: tr(lang, '拒绝', 'Deny'),
  }
}

/**
 * Ask the host to confirm a draft, through the card or — inside a managed
 * desktop — the programmatic consent recorded at desktop start/attach.
 * @param options Accept options.
 * @param env Target environment.
 * @param card Card content.
 * @returns The host's answer.
 */
async function requestAcceptConfirmation(
  options: BaselineAcceptOptions,
  env: NodeJS.ProcessEnv,
  card: LeaseConfirmCard,
): Promise<BaselineConfirmation> {
  const consent: 'card' | 'programmatic' = options.target === undefined || options.target === 'user'
    ? 'card'
    : 'programmatic'
  const reason = tr(options.lang ?? 'zh', '接受本机实测的能力基线',
    'accept the measured capability baseline of this machine')
  if (options.confirm !== undefined) return options.confirm({ reason, card, consent, env })
  // The acceptance is an approval-only consent: the same card, the same decision
  // file and the same terminal record as a lease, without a control handoff.
  const outcome = await requestLease({
    reason, card, approvalOnly: true, consent, consentMs: options.consentMs, env, lang: options.lang,
  })
  return { approved: outcome.allowed, source: outcome.source, phase: outcome.phase }
}

/**
 * Accept the pending draft as this machine's baseline.
 *
 * The host confirms the card the probe produced — the exact verdict, evidence
 * source, and capability counts — and that click is what makes the file
 * readable by the engine. The approval records the evidence hash the human
 * reviewed, and the accept is appended to the audit trail so a later narrowing
 * can be told apart from a fresh acceptance.
 * @param options Environment, clock, and the confirmation path.
 * @returns What became usable.
 * @throws HyprscopeError when there is no usable pending draft, the host denies,
 *   or the confirmation card expires without an answer.
 */
export async function acceptBaseline(options: BaselineAcceptOptions = {}): Promise<BaselineAcceptReport> {
  const env = options.env ?? process.env
  const now = options.now ?? ((): Date => new Date())
  const signature = options.signature ?? null
  const paths = baselinePaths(env, { signature })
  const pending = await readPending(env, signature)
  if (pending === null) {
    throw new HyprscopeError(ErrorCode.COMMAND_FAILED,
      `No pending baseline draft exists at ${paths.pendingFile}; run "hyprscope control baseline --probe" first`,
      { file: paths.pendingFile })
  }
  if (pending.document === null) {
    throw new HyprscopeError(ErrorCode.COMMAND_FAILED,
      `The pending draft is not a usable baseline: ${pending.warnings[0] ?? 'unknown reason'}`,
      { file: pending.path, warnings: pending.warnings })
  }
  const draft = pending.document
  if (draft.approval !== null) {
    throw new HyprscopeError(ErrorCode.COMMAND_FAILED,
      'The pending draft already carries an approval; rerun "hyprscope control baseline --probe"', { file: pending.path })
  }
  const stateWarnings: string[] = []
  const state = computeState(draft.capabilities, stateWarnings)
  const warnings = [...new Set([...pending.warnings, ...stateWarnings])]
  // Approval binds the evidence bytes, not a field in the draft: re-read the
  // file the human reviewed and refuse when it no longer matches. A file that
  // was cleaned up is not fatal (BASELINE.md §6), but the mismatch is.
  let evidenceSha256 = draft.evidence?.sha256 ?? null
  if (draft.evidence !== null) {
    try {
      const actual = createHash('sha256').update(await readFile(draft.evidence.file)).digest('hex')
      if (actual !== draft.evidence.sha256) {
        throw new HyprscopeError(ErrorCode.COMMAND_FAILED,
          'The evidence file changed after the probe; rerun "hyprscope control baseline --probe" before accepting',
          { file: draft.evidence.file, expected: draft.evidence.sha256, observed: actual })
      }
      evidenceSha256 = actual
    } catch (error) {
      if (error instanceof HyprscopeError) throw error
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        warnings.push('the evidence file recorded by the draft is gone; the baseline stays valid, but a later widening must re-probe')
      } else {
        warnings.push(`the evidence file could not be re-read (${code ?? 'unknown error'}); the recorded hash is kept`)
      }
    }
  }
  // Acceptance is the host's decision, never a caller's: the card shows this
  // draft's own counts and evidence before the file becomes readable.
  const confirmation = await requestAcceptConfirmation(options, env,
    confirmationCard(draft, state, options.lang ?? 'zh'))
  if (!confirmation.approved) {
    throw new HyprscopeError(ErrorCode.DENIED,
      confirmation.phase === 'expired'
        ? 'The confirmation card expired before the baseline was accepted'
        : 'The host did not confirm the baseline, so the draft was not accepted',
      { phase: confirmation.phase, source: confirmation.source })
  }
  const approvalSource: BaselineApproval['source'] = confirmation.source === 'overlay'
    ? 'overlay'
    : confirmation.source === 'desktop' ? 'desktop' : 'cli'
  const approvedAt = now().toISOString()
  const document: BaselineDocument = {
    ...draft,
    state,
    approval: { approvedAt, approvedBy: 'human', source: approvalSource, evidenceSha256 },
    revisions: [...(draft.revisions ?? []), { kind: 'accept', at: approvedAt, evidenceSha256 }],
  }
  await writeBaselineFile(paths.baselineFile, document)
  await rm(paths.pendingFile, { force: true })
  const effective = effectiveCapabilities(document.capabilities)
  return {
    accepted: true,
    path: paths.baselineFile,
    state,
    approvedAt,
    approvedBy: 'human',
    source: approvalSource,
    evidenceSha256,
    usable: ordered(effective),
    degraded: levelIds('degraded', effective),
    missingRequired: levelIds('required', effective),
    warnings,
  }
}

/**
 * Describe the accepted baseline and any pending draft.
 *
 * Strictly read-only: it never writes a file and never runs the probe.
 * @param options Environment and whether to compare the draft.
 * @returns Report for the human renderer.
 */
export async function showBaseline(options: BaselineShowOptions = {}): Promise<BaselineShowReport> {
  const env = options.env ?? process.env
  const signature = options.signature ?? null
  const accepted = await readBaseline(env, { signature })
  const effective = accepted.loaded?.effective ?? new Set<CapabilityId>()
  const pending = await readPending(env, signature)
  const stateWarnings: string[] = []
  const pendingState = pending?.document === null || pending?.document === undefined
    ? null
    : computeState(pending.document.capabilities, stateWarnings)
  // The accepted file and the draft explain the same gaps; say each fact once.
  const warnings = [...new Set([...accepted.warnings, ...pending?.warnings ?? [], ...stateWarnings])]
  const pendingSummary: BaselinePendingSummary | null = pending === null ? null : {
    present: true,
    path: pending.path,
    state: pendingState,
    probeId: pending.document?.probe.id ?? null,
    evidenceSha256: pending.document?.evidence?.sha256 ?? null,
  }
  let diff: BaselineShowReport['diff'] = null
  if (options.diff === true && pending !== null) {
    const pendingEffective = pending.document === null ? new Set<CapabilityId>() : effectiveCapabilities(pending.document.capabilities)
    diff = {
      added: ordered(pendingEffective).filter(id => !effective.has(id)),
      removed: ordered(effective).filter(id => !pendingEffective.has(id)),
      acceptedState: accepted.loaded?.state ?? null,
      pendingState,
    }
  }
  return {
    present: accepted.loaded !== null,
    state: accepted.loaded?.state ?? null,
    path: accepted.path,
    reason: accepted.reason,
    approvedAt: accepted.loaded?.approvedAt ?? null,
    compositorVersion: accepted.loaded?.document.fingerprint.compositor.version ?? null,
    effective: ordered(effective),
    degraded: levelIds('degraded', effective),
    missingRequired: levelIds('required', effective),
    warnings,
    pending: pendingSummary,
    diff,
  }
}

/**
 * Render the acceptance card printed after a probe.
 * @param report Probe report.
 * @returns Human-readable lines.
 */
export function renderBaselineProbe(report: BaselineProbeReport): string {
  const lines = [
    `probe ${report.probeId} · ${report.mode} · ${report.state} · ${report.supported.length} supported`
      + ` · ${report.unsupported.length} unsupported · ${report.unknown.length} unknown`,
    '',
    'acceptance card: this records what the probe measured and grants no desktop control',
    '',
    'supported',
    ...(report.supported.length === 0
      ? ['  none']
      : report.supported.map(line => `  ${pad(line.id, 34)} ${pad(line.level, 8)} ${line.evidence}`)),
    '',
    'unsupported or unknown',
    ...(report.unsupported.length + report.unknown.length === 0
      ? ['  none']
      : [...report.unsupported, ...report.unknown].map(line =>
        `  ${pad(line.id, 34)} ${pad(line.status, 11)} ${pad(line.evidence, 10)} ${line.detail ?? 'no detail'}`)),
    '',
    'evidence',
    `  ${report.evidence.file}`,
    `  sha256 ${report.evidence.sha256}`,
    '',
    `difference vs the accepted baseline${report.diff.acceptedState === null
      ? ' (none accepted yet)'
      : ` (${report.diff.acceptedState})`}`,
    `  added:   ${report.diff.added.join(', ') || 'none'}`,
    `  removed: ${report.diff.removed.join(', ') || 'none'}`,
    '',
  ]
  if (report.applied === 'narrowed') {
    lines.push(`narrowed ${report.path} in place: every capability it now grants was already accepted`)
    lines.push('no fresh acceptance is needed; narrowing only makes the tool more conservative')
  } else if (report.applied === 'accepted' && report.accept !== null) {
    lines.push(`accepted ${report.accept.path} after the host answered this probe's confirmation card`)
    lines.push(`state: ${report.accept.state} · approved ${report.accept.approvedAt} by ${report.accept.approvedBy} (${report.accept.source})`)
    lines.push(`usable: ${report.accept.usable.join(', ') || 'none'}`)
    if (report.accept.missingRequired.length > 0) {
      lines.push(`missing required: ${report.accept.missingRequired.join(', ')} — control stays unavailable until they are measured`)
    }
  } else {
    lines.push(`wrote the draft ${report.path}; the confirmation card is part of this command`)
    lines.push(report.state === 'incomplete'
      ? 'state: incomplete — control stays unavailable until a human accepts a baseline that measures every required capability'
      : `state: ${report.state} — control becomes available once a human accepts this baseline`)
    lines.push(report.confirmation === null
      ? 'the host did not answer the card; rerun the probe to ask again'
      : report.confirmation.phase === 'expired'
        ? 'the confirmation card expired; the draft stays pending, so rerun the probe to ask again'
        : 'the host did not approve the draft; rerun the probe to ask again')
  }
  for (const warning of report.warnings) lines.push(`note: ${warning}`)
  return lines.join('\n')
}

/**
 * Render the report printed after an acceptance.
 * @param report Accept report.
 * @returns Human-readable lines.
 */
export function renderBaselineAccept(report: BaselineAcceptReport): string {
  const lines = [
    `accepted ${report.path}`,
    `state: ${report.state} · approved ${report.approvedAt} by ${report.approvedBy} (${report.source})`,
    `evidence sha256: ${report.evidenceSha256 ?? 'none recorded'}`,
    `usable: ${report.usable.join(', ') || 'none'}`,
  ]
  if (report.degraded.length > 0) lines.push(`degraded: ${report.degraded.join(', ')}`)
  if (report.missingRequired.length > 0) {
    lines.push(`missing required: ${report.missingRequired.join(', ')}`)
    lines.push('control stays unavailable while any required capability is unmeasured')
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning}`)
  return lines.join('\n')
}

/**
 * Render the status of the accepted baseline and any pending draft.
 * @param report Show report.
 * @returns Human-readable lines.
 */
export function renderBaselineShow(report: BaselineShowReport): string {
  const lines: string[] = []
  if (!report.present) {
    lines.push(`baseline: none — ${report.reason ?? 'no accepted baseline'}`)
  } else {
    const approved = report.approvedAt === null ? 'not approved' : `approved ${report.approvedAt}`
    const compositor = report.compositorVersion === null ? 'hyprland version unknown' : `hyprland ${report.compositorVersion}`
    lines.push(`baseline: ${report.state ?? 'incomplete'} · ${approved} · ${compositor}`)
  }
  lines.push(`path: ${report.path}`)
  lines.push(`effective: ${report.effective.join(', ') || 'none'}`)
  lines.push(`degraded: ${report.degraded.join(', ') || 'none'}`)
  lines.push(`missing required: ${report.missingRequired.join(', ') || 'none'}`)
  if (report.pending !== null) {
    lines.push(`pending: ${report.pending.path} · probe ${report.pending.probeId ?? '?'} · state ${report.pending.state ?? 'unreadable'}`)
    lines.push('  re-run "hyprscope control baseline --probe" to show the acceptance card again; a denied or expired card leaves this draft pending')
  }
  if (report.diff !== null) {
    lines.push(`diff pending vs accepted: ${report.diff.acceptedState ?? 'none'} → ${report.diff.pendingState ?? 'unreadable'}`)
    lines.push(`  added:   ${report.diff.added.join(', ') || 'none'}`)
    lines.push(`  removed: ${report.diff.removed.join(', ') || 'none'}`)
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning}`)
  return lines.join('\n')
}
