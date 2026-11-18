/**
 * Records for the agent-dedicated desktop.
 *
 * A desktop is one nested Hyprland instance the tool started (target `agent`)
 * or was pointed at by the user (target `external`). The user's own instance is
 * never recorded here: it is the default target and needs no bookkeeping.
 * See `docs/DESKTOP.md`.
 */
import type { Session } from '../types.ts'

/** Which desktop a command addresses. */
export type DesktopTarget = 'user' | 'agent' | 'external'

/** How the human consented to a desktop that is not the user's own. */
export interface DesktopConsent {
  /** `chat` is a confirmation in the conversation; `card` is the lease overlay. */
  source: 'chat' | 'card'
  at: string
  /** One sentence the human was shown, when the caller recorded one. */
  note: string | null
}

/** Lifecycle state of a recorded desktop, as last written by the tool. */
export type DesktopState = 'running' | 'closed' | 'stale'

/** `desktop.json`: the nested or external desktop this installation manages. */
export interface DesktopRecord {
  schema: 1
  /** The user's own desktop is never recorded. */
  target: 'agent' | 'external'
  state: DesktopState
  /** Short runtime root that holds `hypr/<signature>` and the Wayland socket. */
  runtimeDir: string
  signature: string
  waylandDisplay: string
  /** Process id of the nested compositor; null for an external instance. */
  pid: number | null
  /** Generated configuration directory; empty for an external instance. */
  configDir: string
  /** Hash of the generated configuration, or null when the config was not generated. */
  configHash: string | null
  /** Requested output size, such as `1280x800`; null means the parent window size. */
  size: string | null
  consent: DesktopConsent
  createdAt: string
  updatedAt: string
  /** Why the desktop is closed or stale, when the tool knows. */
  detail: string | null
}

/** What one desktop selector resolved to. */
export interface ResolvedTarget {
  target: DesktopTarget
  session: Session
  /** The record for `agent` and `external`; null for the user's desktop. */
  desktop: DesktopRecord | null
  /** Instance signature, always present once resolved. */
  signature: string
  /** Signature that keys this instance's baseline, or null for the machine-wide file. */
  baselineSignature: string | null
  /** Generated-config hash the baseline must cover, when the desktop generated a config. */
  configHash: string | null
  /** Environment with `HYPRSCOPE_LEASE_SIGNATURE` set for a non-user desktop. */
  env: NodeJS.ProcessEnv
}
