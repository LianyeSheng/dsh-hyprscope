/**
 * Reading and computing the capability baseline.
 *
 * Every rule here fails toward "fewer capabilities": a file that cannot be
 * parsed, carries a newer schema, or disagrees with the code catalog can only
 * narrow what the engine may use.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import { CAPABILITY_SPECS, isCapabilityId } from './catalog.ts'
import type {
  BaselineDocument, BaselineState, CapabilityEntry, CapabilityId, CapabilityLevel, CapabilityStatus,
  EvidenceLevel, LoadedBaseline,
} from './types.ts'

/** Schema version this code reads and writes. */
export const BASELINE_SCHEMA = 1

/** Files that make up one baseline installation. */
export interface BaselinePaths {
  dir: string
  /** Approved verdict the engine reads. */
  baselineFile: string
  /** Draft written by the probe, awaiting human acceptance. */
  pendingFile: string
  /** Raw evidence root; one directory per probe. */
  evidenceRoot: string
}

/** Options that select one instance's baseline. */
export interface BaselinePathOptions {
  /** Instance signature; when set, the baseline lives under `desktop/baseline/` instead of the machine-wide file. */
  signature?: string | null
}

/**
 * Resolve the baseline directory and files.
 *
 * The user's desktop keeps the machine-wide file; a nested or external instance
 * is keyed by its signature, so a probe of one desktop can never gate another.
 * @param env Environment that owns the state directory.
 * @param options Instance selector.
 * @returns Absolute paths; `XDG_STATE_HOME` defaults to `~/.local/state`.
 */
export function baselinePaths(env: NodeJS.ProcessEnv = process.env, options: BaselinePathOptions = {}): BaselinePaths {
  const stateHome = env.XDG_STATE_HOME || join(env.HOME ?? '.', '.local', 'state')
  const signature = options.signature ?? null
  if (signature !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(signature)) {
    throw new HyprscopeError(ErrorCode.USAGE, `Instance signature ${signature} is not a safe file name`, { signature })
  }
  const dir = signature === null ? join(stateHome, 'hyprscope') : join(stateHome, 'hyprscope', 'desktop', 'baseline')
  return {
    dir,
    baselineFile: join(dir, signature === null ? 'baseline.json' : `${signature}.json`),
    pendingFile: join(dir, signature === null ? 'baseline.pending.json' : `${signature}.pending.json`),
    // Raw evidence is a run artifact, not state: docs/BASELINE.md puts it under
    // out/baseline/<probeId>/, gitignored, next to the run artifacts.
    evidenceRoot: env.HYPRSCOPE_BASELINE_EVIDENCE_DIR ?? new URL('../../out/baseline', import.meta.url).pathname,
  }
}

/** Result of reading the approved baseline, including why it is missing. */
export interface BaselineReadResult {
  loaded: LoadedBaseline | null
  warnings: string[]
  path: string
  /** One sentence when `loaded` is null; null when a baseline was accepted. */
  reason: string | null
}

/**
 * Read the approved baseline.
 *
 * A missing file, an unreadable file, a newer schema, or a document whose
 * `approval` is null all mean "no baseline": control is unavailable.
 * @param env Environment that owns the state directory.
 * @returns Loaded baseline or the reason there is none.
 */
export async function readBaseline(
  env: NodeJS.ProcessEnv = process.env,
  options: BaselinePathOptions = {},
): Promise<BaselineReadResult> {
  const paths = baselinePaths(env, options)
  let text: string
  try {
    text = await readFile(paths.baselineFile, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      loaded: null,
      warnings: [],
      path: paths.baselineFile,
      reason: code === 'ENOENT'
        ? 'no accepted baseline exists on this machine'
        : `the baseline file could not be read (${code ?? 'unknown error'})`,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { loaded: null, warnings: [], path: paths.baselineFile, reason: 'the baseline file is not JSON' }
  }
  const warnings: string[] = []
  const document = parseBaselineDocument(parsed, warnings)
  if (document === null) {
    return {
      loaded: null, warnings, path: paths.baselineFile,
      reason: warnings[0] ?? 'the baseline file is not a usable baseline',
    }
  }
  if (document.approval === null) {
    return {
      loaded: null, warnings, path: paths.baselineFile,
      reason: 'the baseline is only a draft; a human has not accepted it yet',
    }
  }
  const state = computeState(document.capabilities, warnings)
  if (state !== document.state) {
    warnings.push(`the file says state "${document.state}" but the entries recompute to "${state}"; the recomputed state wins`)
  }
  const effective = effectiveCapabilities(document.capabilities, warnings)
  return {
    loaded: {
      document: { ...document, state },
      state,
      effective,
      warnings,
      approvedAt: document.approval.approvedAt,
    },
    warnings,
    path: paths.baselineFile,
    reason: null,
  }
}

/**
 * Parse one baseline document defensively.
 * @param value Parsed JSON.
 * @param warnings Collector for recoverable disagreements.
 * @returns Document, or null when it must be treated as absent.
 */
export function parseBaselineDocument(value: unknown, warnings: string[] = []): BaselineDocument | null {
  if (typeof value !== 'object' || value === null) {
    warnings.push('the baseline file does not contain an object')
    return null
  }
  const record = value as Record<string, unknown>
  if (record.schema !== BASELINE_SCHEMA) {
    warnings.push(typeof record.schema === 'number' && record.schema > BASELINE_SCHEMA
      ? `the baseline schema ${record.schema} is newer than this tool supports`
      : 'the baseline schema is not 1')
    return null
  }
  if (typeof record.capabilities !== 'object' || record.capabilities === null || Array.isArray(record.capabilities)) {
    warnings.push('the baseline carries no capability table')
    return null
  }
  const capabilities: Record<string, CapabilityEntry> = {}
  for (const [id, raw] of Object.entries(record.capabilities as Record<string, unknown>)) {
    if (!isCapabilityId(id)) {
      warnings.push(`the baseline names capability "${id}", which this version does not know; it is ignored`)
      continue
    }
    const entry = parseEntry(raw, id, warnings)
    if (entry !== null) capabilities[id] = entry
  }
  const approval = parseApproval(record.approval, warnings)
  const probe = parseProbe(record.probe, warnings)
  if (probe === null) return null
  const fingerprint = parseFingerprint(record.fingerprint)
  return {
    schema: 1,
    state: record.state === 'usable' || record.state === 'degraded' || record.state === 'incomplete'
      ? record.state
      : 'incomplete',
    tool: parseTool(record.tool),
    probe,
    fingerprint,
    capabilities,
    evidence: parseEvidence(record.evidence),
    approval,
    revisions: Array.isArray(record.revisions) ? record.revisions.filter(isRevision) : undefined,
    notes: Array.isArray(record.notes) ? record.notes.filter((note): note is string => typeof note === 'string') : undefined,
  }
}

/** Read one capability entry, rejecting nonsense values. */
function parseEntry(raw: unknown, id: string, warnings: string[]): CapabilityEntry | null {
  if (typeof raw !== 'object' || raw === null) {
    warnings.push(`capability "${id}" is not an object; it is treated as unknown`)
    return null
  }
  const record = raw as Record<string, unknown>
  const level = record.level
  const status = record.status
  const evidence = record.evidence
  if (!isLevel(level) || !isStatus(status) || !isEvidence(evidence)) {
    warnings.push(`capability "${id}" has an invalid entry; it is treated as unknown`)
    return null
  }
  const codeLevel = CAPABILITY_SPECS[id as CapabilityId].level
  if (level !== codeLevel) {
    warnings.push(`capability "${id}" says level "${level}" but the code says "${codeLevel}"; the code wins`)
  }
  if (status === 'unsupported' && (typeof record.detail !== 'string' || record.detail === '')) {
    warnings.push(`capability "${id}" is unsupported without a reason; the write rule requires one`)
  }
  return {
    level: codeLevel,
    status,
    evidence,
    checks: Array.isArray(record.checks) ? record.checks.filter(isCheck) : [],
    detail: typeof record.detail === 'string' ? record.detail : null,
  }
}

/** @returns Whether the value is a known level. */
function isLevel(value: unknown): value is CapabilityLevel {
  return value === 'required' || value === 'degraded' || value === 'optional'
}
/** @returns Whether the value is a known status. */
function isStatus(value: unknown): value is CapabilityStatus {
  return value === 'supported' || value === 'unsupported' || value === 'unknown'
}
/** @returns Whether the value is a known evidence level. */
function isEvidence(value: unknown): value is EvidenceLevel {
  return value === 'measured' || value === 'advertised' || value === 'unknown'
}

/** @returns Whether the value looks like one recorded check. */
function isCheck(value: unknown): value is CapabilityEntry['checks'][number] {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.name === 'string' && typeof record.at === 'string' && typeof record.ok === 'boolean'
}

/** @returns Whether the value looks like a revision entry. */
function isRevision(value: unknown): value is NonNullable<BaselineDocument['revisions']>[number] {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (record.kind === 'accept' || record.kind === 'narrow') && typeof record.at === 'string'
}

/**
 * Decide whether one entry satisfies the effective-set formula.
 * @param level Level from the code catalog.
 * @param entry Entry from the baseline, if any.
 * @returns Whether the capability may be used.
 */
export function entrySupports(level: CapabilityLevel, entry: CapabilityEntry | undefined): boolean {
  if (entry === undefined) return false
  if (entry.status !== 'supported') return false
  // "supported" with unknown evidence is the same as unknown.
  if (entry.evidence === 'unknown') return false
  return entry.evidence === 'measured' || level !== 'required'
}

/**
 * Compute the capabilities the engine may use.
 * @param capabilities Verdict entries keyed by id.
 * @param warnings Collector for ids the code does not know.
 * @returns Effective capability set.
 */
export function effectiveCapabilities(
  capabilities: Record<string, CapabilityEntry>,
  warnings: string[] = [],
): ReadonlySet<CapabilityId> {
  const effective = new Set<CapabilityId>()
  for (const id of Object.keys(CAPABILITY_SPECS) as CapabilityId[]) {
    const entry = capabilities[id]
    if (entry === undefined) continue
    const level = CAPABILITY_SPECS[id].level
    if (level === 'required' && entry.status === 'supported' && entry.evidence === 'advertised') {
      warnings.push(`required capability "${id}" is only advertised; it is treated as unknown`)
    }
    // A required capability that is merely advertised still counts as unknown.
    if (entrySupports(level, entry)) effective.add(id)
  }
  return effective
}

/**
 * Recompute the aggregate state from the entries.
 * @param capabilities Verdict entries keyed by id.
 * @param warnings Collector for details that explain an incomplete state.
 * @returns `incomplete`, `degraded`, or `usable`.
 */
export function computeState(capabilities: Record<string, CapabilityEntry>, warnings: string[] = []): BaselineState {
  let usable = true
  let complete = true
  for (const id of Object.keys(CAPABILITY_SPECS) as CapabilityId[]) {
    const spec = CAPABILITY_SPECS[id]
    if (spec.level === 'required') {
      const entry = capabilities[id]
      if (!entrySupports('required', entry)) {
        complete = false
        usable = false
        warnings.push(`required capability "${id}" is not measured as supported`)
      }
    } else if (spec.level === 'degraded' && !entrySupports('degraded', capabilities[id])) {
      usable = false
    }
  }
  if (!complete) return 'incomplete'
  return usable ? 'usable' : 'degraded'
}

/** @returns Empty fingerprint used when a field cannot be measured. */
export function emptyFingerprint(): BaselineDocument['fingerprint'] {
  return {
    compositor: { name: 'hyprland', version: null, branch: null, commit: null, configProvider: null, backend: null },
    monitors: [],
    seats: { count: 0, name: 0 },
    waylandGlobals: [],
    config: { dir: null, luaFile: null, failsafeKey: 'SUPER + ALT + ESC', failsafeBound: false },
    helpers: { inject: false, scratch: false },
    effective: null,
    configHash: null,
  }
}

/** @returns Field-by-field fallback for a missing tool record. */
function parseTool(value: unknown): BaselineDocument['tool'] {
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  return {
    name: typeof record.name === 'string' ? record.name : 'hyprscope',
    version: typeof record.version === 'string' ? record.version : '0.0.0',
  }
}

/** @returns Probe record, or null when the document never says how it was made. */
function parseProbe(value: unknown, warnings: string[]): BaselineDocument['probe'] | null {
  if (typeof value !== 'object' || value === null) {
    warnings.push('the baseline carries no probe record')
    return null
  }
  const record = value as Record<string, unknown>
  return {
    id: typeof record.id === 'string' ? record.id : 'unknown',
    mode: record.mode === 'full' ? 'full' : 'read-only',
    script: typeof record.script === 'string' ? record.script : 'unknown',
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : new Date(0).toISOString(),
    finishedAt: typeof record.finishedAt === 'string' ? record.finishedAt : new Date(0).toISOString(),
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
  }
}

/** @returns Approval record, or null when the document is only a draft. */
function parseApproval(value: unknown, warnings: string[]): BaselineDocument['approval'] {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.approvedBy !== 'human') {
    warnings.push('the baseline approval is not a human approval; it is ignored')
    return null
  }
  if (typeof record.approvedAt !== 'string') return null
  return {
    approvedAt: record.approvedAt,
    approvedBy: 'human',
    source: record.source === 'overlay' ? 'overlay' : 'cli',
    evidenceSha256: typeof record.evidenceSha256 === 'string' ? record.evidenceSha256 : null,
  }
}

/** @returns Evidence record, or null when it is missing or malformed. */
function parseEvidence(value: unknown): BaselineDocument['evidence'] {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.file !== 'string' || typeof record.sha256 !== 'string') return null
  return { file: record.file, sha256: record.sha256 }
}

/** @returns Fingerprint with missing fields defaulted, never throwing. */
function parseFingerprint(value: unknown): BaselineDocument['fingerprint'] {
  const fallback = emptyFingerprint()
  if (typeof value !== 'object' || value === null) return fallback
  const record = value as Record<string, unknown>
  const compositor = typeof record.compositor === 'object' && record.compositor !== null
    ? record.compositor as Record<string, unknown>
    : {}
  const seats = typeof record.seats === 'object' && record.seats !== null
    ? record.seats as Record<string, unknown>
    : {}
  const config = typeof record.config === 'object' && record.config !== null
    ? record.config as Record<string, unknown>
    : {}
  const helpers = typeof record.helpers === 'object' && record.helpers !== null
    ? record.helpers as Record<string, unknown>
    : {}
  return {
    compositor: {
      name: 'hyprland',
      version: typeof compositor.version === 'string' ? compositor.version : null,
      branch: typeof compositor.branch === 'string' ? compositor.branch : null,
      commit: typeof compositor.commit === 'string' ? compositor.commit : null,
      configProvider: typeof compositor.configProvider === 'string' ? compositor.configProvider : null,
      backend: typeof compositor.backend === 'string' ? compositor.backend : null,
    },
    monitors: Array.isArray(record.monitors)
      ? record.monitors.filter(isMonitorFingerprint).sort((left, right) => left.name.localeCompare(right.name))
      : [],
    seats: {
      count: typeof seats.count === 'number' ? seats.count : 0,
      name: typeof seats.name === 'number' ? seats.name : 0,
    },
    waylandGlobals: Array.isArray(record.waylandGlobals)
      ? record.waylandGlobals.filter(isGlobalFingerprint).sort((left, right) => left.interface.localeCompare(right.interface))
      : [],
    config: {
      dir: typeof config.dir === 'string' ? config.dir : null,
      luaFile: typeof config.luaFile === 'string' ? config.luaFile : null,
      failsafeKey: typeof config.failsafeKey === 'string' ? config.failsafeKey : fallback.config.failsafeKey,
      failsafeBound: config.failsafeBound === true,
    },
    helpers: {
      inject: helpers.inject === true,
      scratch: helpers.scratch === true,
    },
    effective: parseEffective(record.effective),
    configHash: typeof record.configHash === 'string' && record.configHash !== '' ? record.configHash : null,
  }
}

/**
 * Parse the effective runtime values, tolerating every older or malformed shape.
 * @param value Raw fingerprint field.
 * @returns Effective values, or null when the file predates drift tracking.
 */
function parseEffective(value: unknown): BaselineDocument['fingerprint']['effective'] {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const binds = typeof record.binds === 'object' && record.binds !== null
    ? record.binds as Record<string, unknown>
    : null
  return {
    configProvider: typeof record.configProvider === 'string' ? record.configProvider : null,
    followMouse: typeof record.followMouse === 'string' ? record.followMouse : null,
    binds: binds !== null && typeof binds.count === 'number' && typeof binds.plainF12 === 'boolean'
      ? { count: binds.count, plainF12: binds.plainF12 }
      : null,
    configErrors: Array.isArray(record.configErrors)
      ? record.configErrors.filter((item): item is string => typeof item === 'string')
      : null,
  }
}

/** @returns Whether the value looks like one monitor fingerprint. */
function isMonitorFingerprint(value: unknown): value is BaselineDocument['fingerprint']['monitors'][number] {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.name === 'string' && typeof record.x === 'number' && typeof record.y === 'number'
    && typeof record.width === 'number' && typeof record.height === 'number'
}

/** @returns Whether the value looks like one Wayland global. */
function isGlobalFingerprint(value: unknown): value is BaselineDocument['fingerprint']['waylandGlobals'][number] {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.interface === 'string' && typeof record.version === 'number'
}

/**
 * Write one baseline document atomically.
 *
 * The temporary file lives beside the target so the rename cannot cross a
 * filesystem boundary; the file is `0600`, like the lease state.
 * @param file Target path.
 * @param document Document to write.
 */
export async function writeBaselineFile(file: string, document: BaselineDocument): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}
