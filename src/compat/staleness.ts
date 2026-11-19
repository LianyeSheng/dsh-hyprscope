/**
 * Drift detection between the accepted baseline and the running compositor.
 *
 * A baseline records what the probe measured; this module asks whether the
 * running instance still matches it. The comparison fails toward fewer
 * capabilities: a value the baseline does not record is `unverified`, and a
 * value the live compositor cannot report is `stale`, so neither is ever
 * mistaken for agreement. See `docs/cli/COMPATIBILITY.md` §5.1.
 */
import { hyprctlJson } from '../hyprctl.ts'
import type { RawStatus, RawVersion, Session } from '../types.ts'
import type { Fingerprint } from './types.ts'

/** Per-query timeout used when the caller does not set one. */
const DEFAULT_TIMEOUT_MS = 5000

/** Runtime-effective configuration read from the live compositor. */
export interface EffectiveState {
  /** `hyprctl version` version string, or null when the query failed. */
  version: string | null
  /** Configuration provider reported by `hyprctl status`, or null. */
  configProvider: string | null
  /** Effective `input:follow_mouse` value, as hyprctl prints it, or null. */
  followMouse: string | null
  /** Number of entries in `hyprctl binds`, or null when the query failed. */
  bindCount: number | null
  /** Whether F12 is bound with no modifiers, or null when binds failed. */
  plainF12: boolean | null
  /**
   * Errors reported by `hyprctl configerrors`, or null when it failed.
   * Normalized: entries are trimmed and empty entries are dropped, so the
   * compositor's `[""]` "no errors" shape yields an empty list.
   */
  configErrors: string[] | null
}

/**
 * What the comparison established.
 *
 * `fresh` means every recorded value that can be compared still matches;
 * `stale` means a value differs or the running instance could not report one;
 * `unverified` means the baseline does not record a value the comparison needs.
 */
export type StalenessVerdict = 'fresh' | 'stale' | 'unverified'

/** One recorded/observed disagreement, rendered as strings. */
export interface StalenessDifference {
  /** Dotted field name: `version`, `binds.count`, `configErrors`, and so on. */
  field: string
  /** Recorded value as text; numbers and booleans use their text form. */
  recorded: string | null
  /** Observed value as text, or null when the live query failed. */
  observed: string | null
}

/** The outcome of comparing a fingerprint with the running instance. */
export interface StalenessReport {
  /** Aggregate verdict; `stale` outranks `unverified`. */
  verdict: StalenessVerdict
  /** Human sentences, in deterministic comparison order. */
  reasons: string[]
  /** Field differences, sorted by field name. */
  differences: StalenessDifference[]
  /** When the comparison ran, ISO 8601. */
  measuredAt: string
  /** Whether the fingerprint records effective configuration at all. */
  recorded: boolean
}

/** One `hyprctl -j getoption` result. */
interface RawOption {
  int?: unknown
  custom?: unknown
  str?: unknown
}

/** One `hyprctl -j binds` record; fields stay optional across Hyprland versions. */
interface RawBind {
  modmask?: number
  key?: string
}

/** Comparison accumulator shared by the per-field checks. */
interface Comparison {
  reasons: string[]
  differences: StalenessDifference[]
  /** At least one recorded value is missing, so no complete attestation exists. */
  unverified: boolean
  /** At least one value differs or could not be observed. */
  stale: boolean
}

/**
 * Read the runtime-effective configuration from the live compositor.
 *
 * Each query runs independently: a failure leaves its fields null and never
 * rejects, because a staleness check that throws is worse than one that says
 * "cannot attest". The binary is chosen by `HYPRSCOPE_HYRPRCTL` inside
 * `src/hyprctl.ts`, so tests can point it at a fake script.
 * @param session Discovered session (runtime directory and instance signature).
 * @param options Per-query timeout in milliseconds; defaults to 5000.
 * @returns Effective values measured from the compositor, with failures as null.
 */
export async function measureEffective(
  session: Pick<Session, 'runtimeDir' | 'signature'>,
  options?: { timeoutMs?: number },
): Promise<EffectiveState> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS

  /**
   * Run one read-only query, turning any failure into null.
   * @param command Read-only `hyprctl` command.
   * @param args Command arguments.
   * @returns Parsed JSON, or null when the query failed.
   */
  const read = async <T>(command: string, args: string[] = []): Promise<T | null> => {
    try {
      return await hyprctlJson<T>(session, command, args, { timeoutMs })
    } catch {
      return null
    }
  }

  const [version, status, option, binds, configErrors] = await Promise.all([
    read<RawVersion>('version'),
    read<RawStatus>('status'),
    read<RawOption>('getoption', ['input:follow_mouse']),
    read<unknown>('binds'),
    read<unknown>('configerrors'),
  ] as const)

  const state: EffectiveState = {
    version: typeof version?.version === 'string' ? version.version : null,
    configProvider: typeof status?.configProvider === 'string' ? status.configProvider : null,
    followMouse: null,
    bindCount: null,
    plainF12: null,
    configErrors: null,
  }
  if (typeof option?.int === 'number') state.followMouse = String(option.int)
  else if (typeof option?.custom === 'string') state.followMouse = option.custom
  else if (typeof option?.str === 'string') state.followMouse = option.str
  if (Array.isArray(binds)) {
    state.bindCount = binds.length
    state.plainF12 = binds.some(bind => isPlainBind(bind) && (bind.modmask ?? 0) === 0 && (bind.key ?? '') === 'F12')
  }
  if (Array.isArray(configErrors)) state.configErrors = normalizeConfigErrors(configErrors)
  return state
}

/**
 * Compare an accepted fingerprint with freshly measured effective state.
 *
 * The comparison order is version, provider, `input:follow_mouse`, bind count,
 * plain F12, configuration errors (as a set), and the config hash. A recorded
 * value that is missing makes the report `unverified`; an observed value that
 * is missing makes it `stale`. Differences are rendered as strings and sorted
 * by field name, so two runs over the same inputs are identical.
 * @param fingerprint Fingerprint recorded by the probe.
 * @param observed Effective state measured from the running instance.
 * @param options Optional observed config hash, timestamps, and clock.
 * @returns Deterministic staleness report.
 */
export function compareEffective(
  fingerprint: Fingerprint,
  observed: EffectiveState,
  options?: {
    configHash?: string | null
    measuredAt?: string
    approvedAt?: string | null
    now?: () => Date
  },
): StalenessReport {
  const now = options?.now ?? (() => new Date())
  const measuredAt = options?.measuredAt ?? now().toISOString()
  const effective = fingerprint.effective

  if (effective == null) {
    return {
      verdict: 'unverified',
      reasons: [
        'The accepted baseline does not record effective configuration, so it must be re-probed before drift can be checked.',
      ],
      differences: [],
      measuredAt,
      recorded: false,
    }
  }

  const comparison: Comparison = { reasons: [], differences: [], unverified: false, stale: false }
  compareField(comparison, 'version', 'the compositor version',
    fingerprint.compositor.version, observed.version)
  compareField(comparison, 'configProvider', 'the configuration provider',
    effective.configProvider ?? fingerprint.compositor.configProvider, observed.configProvider)
  compareField(comparison, 'followMouse', 'the effective input:follow_mouse value',
    effective.followMouse, observed.followMouse)

  if (effective.binds === null) {
    comparison.unverified = true
    comparison.reasons.push(
      'The baseline does not record the bind summary, so the bind count and the plain F12 binding cannot be attested.',
    )
  } else {
    compareField(comparison, 'binds.count', 'the bind count',
      String(effective.binds.count), observed.bindCount === null ? null : String(observed.bindCount))
    compareField(comparison, 'binds.plainF12', 'whether F12 is bound without modifiers',
      String(effective.binds.plainF12), observed.plainF12 === null ? null : String(observed.plainF12))
  }

  if (effective.configErrors === null) {
    // The probe writes null only when `hyprctl configerrors` failed, so the
    // recorded side cannot attest anything about configuration errors.
    comparison.unverified = true
    comparison.reasons.push(
      'The baseline does not record the configuration errors, so that value cannot be attested.',
    )
  } else if (observed.configErrors === null) {
    comparison.stale = true
    comparison.reasons.push(
      'The live compositor did not report the configuration errors, so the running instance cannot be attested.',
    )
  } else {
    // Old fingerprints may carry the compositor's [""] "no errors" shape, and
    // current ones are normalized at measurement time; normalize both sides so
    // the set comparison means the same thing everywhere.
    const recordedErrors = normalizeConfigErrors(effective.configErrors)
    const observedErrors = normalizeConfigErrors(observed.configErrors)
    if (!sameStringSet(recordedErrors, observedErrors)) {
      const recorded = formatConfigErrors(recordedErrors)
      const live = formatConfigErrors(observedErrors)
      comparison.stale = true
      comparison.differences.push({ field: 'configErrors', recorded, observed: live })
      comparison.reasons.push(`The configuration errors changed from "${recorded}" to "${live}".`)
    }
  }

  // A null recorded hash means no generated configuration: there is nothing to
  // compare and no reason to suspect drift.
  if (fingerprint.configHash !== null) {
    const observedHash = options?.configHash ?? null
    if (observedHash === null) {
      comparison.stale = true
      comparison.reasons.push(
        'The baseline records a configuration hash, but the live configuration hash is unavailable, '
          + 'so the running configuration cannot be attested.',
      )
    } else if (observedHash !== fingerprint.configHash) {
      comparison.stale = true
      comparison.differences.push({
        field: 'configHash',
        recorded: fingerprint.configHash,
        observed: observedHash,
      })
      comparison.reasons.push(
        `The configuration hash changed from "${fingerprint.configHash}" to "${observedHash}".`,
      )
    }
  }

  const verdict: StalenessVerdict = comparison.stale ? 'stale' : comparison.unverified ? 'unverified' : 'fresh'
  if (verdict === 'stale' && options?.approvedAt != null) {
    comparison.reasons.push(`The baseline accepted at ${options.approvedAt} no longer matches the running compositor.`)
  }
  comparison.differences.sort((left, right) => compareText(left.field, right.field))
  return {
    verdict,
    reasons: comparison.reasons,
    differences: comparison.differences,
    measuredAt,
    recorded: true,
  }
}

/**
 * Whether a parsed bind entry has the fields the summary reads.
 * @param value Untrusted element from `hyprctl binds -j`.
 * @returns Whether the value is a bind record.
 */
function isPlainBind(value: unknown): value is RawBind {
  return typeof value === 'object' && value !== null
}

/**
 * Record one field's verdict in the accumulator.
 * @param comparison Report under construction.
 * @param field Dotted field name used in differences.
 * @param label Human noun phrase used in reasons.
 * @param recorded Recorded value, or null when the baseline omits it.
 * @param observed Observed value, or null when the live query failed.
 */
function compareField(
  comparison: Comparison,
  field: string,
  label: string,
  recorded: string | null,
  observed: string | null,
): void {
  if (recorded === null) {
    comparison.unverified = true
    comparison.reasons.push(`The baseline does not record ${label}, so that value cannot be attested.`)
    return
  }
  if (observed === null) {
    comparison.stale = true
    comparison.reasons.push(
      `The live compositor did not report ${label}, so the running instance cannot be attested.`,
    )
    return
  }
  if (recorded === observed) return
  comparison.stale = true
  comparison.differences.push({ field, recorded, observed })
  comparison.reasons.push(`${capitalize(label)} changed from "${recorded}" to "${observed}".`)
}

/**
 * @param left First text.
 * @param right Second text.
 * @returns Ordering independent of locale, for stable report output.
 */
function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * @param text Noun phrase.
 * @returns The phrase with its first character capitalized.
 */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Normalize configuration errors to meaningful text.
 *
 * The compositor reports `[""]` when there are no errors, and old fingerprints
 * may have stored that shape. Mapping to strings, trimming, and dropping empty
 * entries makes `[""]`, `[]`, and `["  "]` all mean "no errors".
 * @param errors Errors reported by the probe or the live compositor.
 * @returns Trimmed, non-empty errors in their original order.
 */
function normalizeConfigErrors(errors: readonly unknown[]): string[] {
  return errors.map(String).map(error => error.trim()).filter(error => error !== '')
}

/**
 * Render configuration errors as a set-like line for a difference entry.
 * @param errors Errors already normalized by {@link normalizeConfigErrors}.
 * @returns Unique errors sorted and joined with ` | `.
 */
function formatConfigErrors(errors: readonly string[]): string {
  return [...new Set(errors)].sort(compareText).join(' | ')
}

/**
 * Compare two error lists by content, ignoring order and duplicates.
 * @param left First list.
 * @param right Second list.
 * @returns Whether both lists contain the same errors.
 */
function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  const first = new Set(left)
  const second = new Set(right)
  if (first.size !== second.size) return false
  for (const value of first) {
    if (!second.has(value)) return false
  }
  return true
}
