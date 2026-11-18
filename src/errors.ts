/** Coded failures shared by discovery, native queries, events, and capture. */
import type { ErrorCodeValue } from './types.ts'

/** Error codes reported to callers; stable strings rather than prose matching. */
export const ErrorCode = {
  USAGE: 'USAGE',
  NO_SESSION: 'NO_SESSION',
  SESSION_GONE: 'SESSION_GONE',
  READ_ONLY: 'READ_ONLY',
  COMMAND_FAILED: 'COMMAND_FAILED',
  BAD_OUTPUT: 'BAD_OUTPUT',
  LOCKED: 'LOCKED',
  SCREENSHOT_FAILED: 'SCREENSHOT_FAILED',
  TIMEOUT: 'TIMEOUT',
  LEASE_ACTIVE: 'LEASE_ACTIVE',
  NO_LEASE: 'NO_LEASE',
  DENIED: 'DENIED',
  OVERLAY_FAILED: 'OVERLAY_FAILED',
  BIND_FAILED: 'BIND_FAILED',
  PLAN_INVALID: 'PLAN_INVALID',
  LEASE_MISMATCH: 'LEASE_MISMATCH',
  FAULTED: 'FAULTED',
  INJECTOR_FAILED: 'INJECTOR_FAILED',
  CAPABILITY: 'CAPABILITY',
  DESKTOP_FAILED: 'DESKTOP_FAILED',
  TARGET_UNAVAILABLE: 'TARGET_UNAVAILABLE',
} as const

/** Failure carrying a stable code plus machine-readable details. */
export class HyprscopeError extends Error {
  readonly code: ErrorCodeValue
  readonly details: Record<string, unknown>

  /**
   * @param code One of {@link ErrorCode}.
   * @param message Human-readable reason naming the failed operation.
   * @param details Extra facts for JSON consumers.
   */
  constructor(code: ErrorCodeValue, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HyprscopeError'
    this.code = code
    this.details = details
  }
}
