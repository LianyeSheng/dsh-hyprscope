/**
 * Records for the capability baseline.
 *
 * The baseline is a per-machine verdict: what the probe actually measured, the
 * environment it was measured in, who approved it, and which capabilities may
 * be used at run time. It records machine capability only, never runtime state
 * and never application behavior. See `docs/COMPATIBILITY.md` and
 * `docs/BASELINE.md`.
 */

/** Capability ids declared by code; the baseline can only subtract from them. */
export type CapabilityId =
  | 'observe.hyprctl'
  | 'observe.geometry'
  | 'observe.cursor'
  | 'dispatch.lua'
  | 'inject.pointer'
  | 'inject.keyboard'
  | 'events.socket'
  | 'safety.failsafe-bind'
  | 'dispatch.focus.window'
  | 'dispatch.focus.workspace'
  | 'dispatch.window.move'
  | 'dispatch.window.resize'
  | 'dispatch.window.float'
  | 'dispatch.window.pin'
  | 'dispatch.window.fullscreen-state'
  | 'observe.window.modes'
  | 'capture.grim'
  | 'capture.window'
  | 'observe.lock'
  | 'dispatch.window.move-to-workspace'

/** How much a missing capability costs. */
export type CapabilityLevel = 'required' | 'degraded' | 'optional'

/** The verdict for one capability. */
export type CapabilityStatus = 'supported' | 'unsupported' | 'unknown'

/** The strength of the basis for a verdict. */
export type EvidenceLevel = 'measured' | 'advertised' | 'unknown'

/** Aggregate state of one baseline. */
export type BaselineState = 'usable' | 'degraded' | 'incomplete'

/** One round trip the probe recorded. */
export interface CapabilityCheck {
  /** Step name, unique within the capability. */
  name: string
  /** When the step ran, ISO 8601. */
  at: string
  /** What the probe expected to observe. */
  expected?: unknown
  /** What it observed instead. */
  observed?: unknown
  /** Whether the observation matched the expectation. */
  ok: boolean
  /** One sentence when the step failed. */
  detail?: string
}

/** The baseline's record for one capability. */
export interface CapabilityEntry {
  /** Level at write time; readers take the code catalog as authoritative. */
  level: CapabilityLevel
  status: CapabilityStatus
  evidence: EvidenceLevel
  checks: CapabilityCheck[]
  /** Reason when unsupported or unknown. */
  detail: string | null
}

/** One monitor as the fingerprint records it; raw `hyprctl -j` field names. */
export interface MonitorFingerprint {
  name: string
  x: number
  y: number
  width: number
  height: number
  scale: number
  refreshRate: number
  transform: number
  dpmsStatus: boolean
}

/** One Wayland registry global. */
export interface GlobalFingerprint {
  interface: string
  version: number
}

/** Runtime-effective configuration recorded beside the probe verdict. */
export interface EffectiveFingerprint {
  /** Configuration provider the running instance reported. */
  configProvider: string | null
  /** Effective `input:follow_mouse` value, as hyprctl prints it. */
  followMouse: string | null
  /** Bind summary: how many binds exist, and whether a plain F12 is bound. */
  binds: { count: number; plainF12: boolean } | null
  /** Configuration errors the instance reported. */
  configErrors: string[] | null
}

/** The environment the probe measured. It takes no part in the verdict. */
export interface Fingerprint {
  compositor: {
    name: 'hyprland'
    version: string | null
    branch: string | null
    commit: string | null
    configProvider: string | null
    backend: string | null
  }
  monitors: MonitorFingerprint[]
  seats: { count: number; name: number }
  waylandGlobals: GlobalFingerprint[]
  config: {
    dir: string | null
    luaFile: string | null
    failsafeKey: string
    failsafeBound: boolean
  }
  helpers: { inject: boolean; scratch: boolean }
  /** Effective runtime values; null on a file written before drift tracking. */
  effective: EffectiveFingerprint | null
  /** Hash of the generated config this baseline belongs to, when one generated it. */
  configHash: string | null
}

/** How the baseline was produced. */
export interface BaselineProbeRecord {
  id: string
  mode: 'full' | 'read-only'
  /** Probe script version identifier, used to interpret the evidence. */
  script: string
  startedAt: string
  finishedAt: string
  durationMs: number
}

/** Human acceptance of one baseline. */
export interface BaselineApproval {
  approvedAt: string
  approvedBy: 'human'
  source: 'cli' | 'overlay' | 'desktop'
  /** Hash of the evidence file the human approved. */
  evidenceSha256: string | null
}

/** One audit entry: a fresh acceptance or an automatic narrowing. */
export interface BaselineRevision {
  kind: 'accept' | 'narrow'
  at: string
  evidenceSha256: string | null
}

/** `baseline.json`: the capability verdict for one machine. */
export interface BaselineDocument {
  schema: 1
  state: BaselineState
  tool: { name: string; version: string }
  probe: BaselineProbeRecord
  fingerprint: Fingerprint
  capabilities: Record<string, CapabilityEntry>
  evidence: { file: string; sha256: string } | null
  approval: BaselineApproval | null
  revisions?: BaselineRevision[]
  notes?: string[]
}

/** A baseline the engine may use, plus the facts it derived from it. */
export interface LoadedBaseline {
  document: BaselineDocument
  /** Recomputed from the entries and the code catalog, never read from the file. */
  state: BaselineState
  /** Capabilities that pass the effective-set formula. */
  effective: ReadonlySet<CapabilityId>
  /** Reader warnings: unknown ids, level disagreements, state mismatches. */
  warnings: string[]
  approvedAt: string
}

/** Code-owned behavior of one capability. */
export interface CapabilitySpec {
  level: CapabilityLevel
  /** What the probe checks, one sentence. */
  detection: string
  /** What stops working when the capability is missing. */
  consequence: string
}
