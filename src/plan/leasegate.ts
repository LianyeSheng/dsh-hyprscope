/**
 * Lease gate for plan execution.
 *
 * Every mutating call proves it still holds the lease that approved this run:
 * right lease id, still `granted`, bound to a submitted plan, not expired. This
 * is a correctness mechanism until lease state moves outside the agent's uid
 * (see `docs/LEASE.md`).
 */
import { ErrorCode, HyprscopeError } from '../errors.ts'
import { isActive, leasePaths, readState, type LeaseState } from '../lease/state.ts'

/** Proof that the current lease approved one specific plan submission. */
export interface PlanGrant {
  leaseId: string
  expiresAt: string
}

/**
 * Read the state file without the gate.
 * @param env Environment to read.
 * @returns Lease state or null.
 */
async function readGatedState(env: NodeJS.ProcessEnv): Promise<LeaseState | null> {
  return readState(leasePaths(env))
}

/**
 * Require an active lease bound to a submitted plan.
 * @param env Environment to read.
 * @returns Grant to carry through execution.
 */
export async function requirePlanGrant(env: NodeJS.ProcessEnv = process.env): Promise<PlanGrant> {
  const state = await readGatedState(env)
  if (state === null || !isActive(state.phase)) {
    throw new HyprscopeError(ErrorCode.NO_LEASE, 'No control lease is active', { phase: state?.phase ?? null })
  }
  if (state.phase !== 'granted') {
    throw new HyprscopeError(ErrorCode.NO_LEASE, 'The consent card has not been approved yet', { phase: state.phase })
  }
  const grant = { leaseId: state.leaseId, expiresAt: state.expiresAt ?? '' }
  requireLiveState(state, grant)
  return grant
}

/**
 * Re-check the grant immediately before a mutating call.
 * @param grant Grant issued by {@link requirePlanGrant}.
 * @param env Environment to read.
 */
export async function assertPlanGrant(grant: PlanGrant, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const state = await readGatedState(env)
  if (state === null) {
    throw new HyprscopeError(ErrorCode.LEASE_MISMATCH, 'The control lease disappeared', { leaseId: grant.leaseId })
  }
  requireLiveState(state, grant)
}

/**
 * Verify one state record against a grant.
 * @param state Current lease state.
 * @param grant Expected identity and expiry.
 */
function requireLiveState(state: LeaseState, grant: PlanGrant): void {
  if (state.phase !== 'granted') {
    throw new HyprscopeError(ErrorCode.LEASE_MISMATCH, `Control was ${state.phase === 'revoked' ? 'revoked' : 'released'}`, {
      phase: state.phase, leaseId: state.leaseId, endReason: state.endReason,
    })
  }
  if (state.leaseId !== grant.leaseId) {
    throw new HyprscopeError(ErrorCode.LEASE_MISMATCH, 'The lease changed underneath the running plan', {
      expected: grant.leaseId, observed: state.leaseId,
    })
  }
  if (state.planBound !== true) {
    throw new HyprscopeError(ErrorCode.LEASE_MISMATCH, 'The lease is not bound to a submitted plan', {
      leaseId: state.leaseId, planBound: state.planBound ?? false,
    })
  }
  const expiresAt = state.expiresAt === null ? Number.NaN : Date.parse(state.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new HyprscopeError(ErrorCode.LEASE_MISMATCH, 'The lease expired during execution', {
      expiresAt: state.expiresAt,
    })
  }
}
