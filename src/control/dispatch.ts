/**
 * Lease-gated dispatcher subset for Hyprland's Lua config provider.
 *
 * This compositor evaluates `hyprctl dispatch <expression>` as Lua
 * (`hl.dispatch(<expression>)`), so classic string dispatchers do not work.
 * This module owns the semantic subset a plan may reach: it builds the Lua
 * expression from validated values only, refuses everything else, and runs it
 * only after the caller's lease check passes.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ErrorCode, HyprscopeError } from '../errors.ts'
import type { Session } from '../types.ts'

const run = promisify(execFile)

/** Window address as Hyprland prints it. */
const ADDRESS = /^0x[0-9a-f]+$/
/** Workspace name or number accepted by the plan language. */
const WORKSPACE = /^[A-Za-z0-9._-]{1,32}$/

/**
 * Test a value against the fullscreen mode whitelist.
 * @param value Candidate mode from a dispatch request.
 * @returns True for the three modes Hyprland accepts.
 */
function isFullscreenMode(value: unknown): value is 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2
}

/**
 * Dispatchers a plan may reach. Semantic operations replace raw `dispatch`:
 * there is deliberately no generic escape hatch and no Lua-passing API.
 */
export type DispatchRequest =
  | { kind: 'focusWindow'; windowId: string }
  | { kind: 'workspace'; name: string }
  | { kind: 'moveWindow'; windowId: string; x: number; y: number }
  | { kind: 'resizeWindow'; windowId: string; x: number; y: number }
  | { kind: 'moveWindowToWorkspace'; windowId: string; workspace: string; silent: boolean }
  | { kind: 'floatWindow'; windowId: string; floating: boolean }
  | { kind: 'pinWindow'; windowId: string; pinned: boolean }
  | { kind: 'fullscreenWindow'; windowId: string; internal: 0 | 1 | 2; client: 0 | 1 | 2 }

/** Kinds reported in errors and tests. */
export const DISPATCH_KINDS = [
  'focusWindow', 'workspace', 'moveWindow', 'resizeWindow',
  'moveWindowToWorkspace', 'floatWindow', 'pinWindow', 'fullscreenWindow',
] as const

/**
 * Reject a request shape before any expression is built.
 * @param request Candidate dispatcher call.
 */
export function assertDispatchRequest(request: DispatchRequest): void {
  const fail = (reason: string): never => {
    throw new HyprscopeError(ErrorCode.USAGE, `Bad dispatch request: ${reason}`, { request })
  }
  /** Refuse anything that is not a Hyprland window address. */
  const requireAddress = (windowId: unknown): void => {
    if (typeof windowId !== 'string' || !ADDRESS.test(windowId)) fail(`expected a window address, got ${JSON.stringify(windowId)}`)
  }
  /** Refuse anything that is not a plan-language workspace name. */
  const requireWorkspace = (name: unknown): void => {
    if (typeof name !== 'string' || !WORKSPACE.test(name)) fail(`expected a workspace name, got ${JSON.stringify(name)}`)
  }
  switch (request.kind) {
    case 'focusWindow':
      requireAddress(request.windowId)
      return
    case 'workspace':
      requireWorkspace(request.name)
      return
    case 'moveWindow':
    case 'resizeWindow':
      requireAddress(request.windowId)
      for (const value of [request.x, request.y]) {
        if (!Number.isInteger(value) || value < -100_000 || value > 100_000) fail('x and y must be integers in range')
      }
      return
    case 'moveWindowToWorkspace':
      requireAddress(request.windowId)
      requireWorkspace(request.workspace)
      if (typeof request.silent !== 'boolean') fail('silent must be a boolean')
      return
    case 'floatWindow':
      requireAddress(request.windowId)
      if (typeof request.floating !== 'boolean') fail('floating must be a boolean')
      return
    case 'pinWindow':
      requireAddress(request.windowId)
      if (typeof request.pinned !== 'boolean') fail('pinned must be a boolean')
      return
    case 'fullscreenWindow':
      requireAddress(request.windowId)
      if (!isFullscreenMode(request.internal)) fail('internal must be 0, 1, or 2')
      if (!isFullscreenMode(request.client)) fail('client must be 0, 1, or 2')
      return
    default:
      fail(`unsupported dispatch kind ${String((request as { kind?: unknown }).kind)}`)
  }
}

/**
 * Build the Lua expression the compositor evaluates.
 *
 * Every interpolated value passed {@link assertDispatchRequest}: addresses and
 * workspace names match their regexes and modes are 0/1/2, so an expression can
 * never carry quotes, escapes, or a call the whitelist did not intend.
 * @param request Validated dispatcher call.
 * @returns Expression passed as the single `hyprctl dispatch` argument.
 */
export function luaExpression(request: DispatchRequest): string {
  assertDispatchRequest(request)
  if (request.kind === 'workspace') {
    return `hl.dsp.focus({ workspace = ${JSON.stringify(request.name)} })`
  }
  const window = `"address:${request.windowId}"`
  switch (request.kind) {
    case 'focusWindow':
      return `hl.dsp.focus({ window = ${window} })`
    case 'moveWindow':
      return `hl.dsp.window.move({ window = ${window}, x = ${request.x}, y = ${request.y} })`
    case 'resizeWindow':
      return `hl.dsp.window.resize({ window = ${window}, x = ${request.x}, y = ${request.y} })`
    case 'moveWindowToWorkspace':
      // `silent` mirrors the classic dispatcher: follow = false leaves the
      // active workspace in place, follow = true switches to the target.
      return `hl.dsp.window.move({ window = ${window}, workspace = ${JSON.stringify(request.workspace)}, follow = ${request.silent ? 'false' : 'true'} })`
    case 'floatWindow':
      return `hl.dsp.window.float({ window = ${window}, action = ${request.floating ? '"on"' : '"off"'} })`
    case 'pinWindow':
      return `hl.dsp.window.pin({ action = ${request.pinned ? '"on"' : '"off"'}, window = ${window} })`
    case 'fullscreenWindow':
      return `hl.dsp.window.fullscreen_state({ window = ${window}, internal = ${request.internal}, client = ${request.client}, action = "set" })`
    default:
      throw new HyprscopeError(ErrorCode.USAGE, 'Unsupported dispatch kind')
  }
}

/**
 * Run one allowlisted dispatcher after the caller's lease guard passes.
 * @param session Discovered session.
 * @param guard Lease check; must throw when control is not held.
 * @param request Dispatcher call.
 * @param options Binary and timeout overrides.
 * @returns Compositor output; warnings are treated as failures.
 */
export async function dispatchWithLease(
  session: Pick<Session, 'runtimeDir' | 'signature'>,
  guard: () => Promise<void>,
  request: DispatchRequest,
  options: { timeoutMs?: number; binary?: string } = {},
): Promise<string> {
  const expression = luaExpression(request)
  await guard()
  const binary = options.binary ?? process.env.HYPRSCOPE_HYRPRCTL ?? 'hyprctl'
  const env = { ...process.env, XDG_RUNTIME_DIR: session.runtimeDir, HYPRLAND_INSTANCE_SIGNATURE: session.signature }
  let stdout = ''
  try {
    const result = await run(binary, ['dispatch', expression], {
      env, timeout: options.timeoutMs ?? 3_000, maxBuffer: 1024 * 1024, encoding: 'utf8',
    })
    stdout = result.stdout
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string; stdout?: string }
    const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : ''
    const output = `${stderr} ${typeof failure.stdout === 'string' ? failure.stdout.trim() : ''}`.trim()
    if (/HYPRLAND_INSTANCE_SIGNATURE not set|Couldn't connect|No such file/i.test(output)) {
      throw new HyprscopeError(ErrorCode.SESSION_GONE, 'Cannot reach the compositor for a dispatch', { expression, output })
    }
    if (failure.killed === true) {
      throw new HyprscopeError(ErrorCode.TIMEOUT, 'A dispatch did not finish in time', { expression })
    }
    throw new HyprscopeError(ErrorCode.COMMAND_FAILED, `dispatch ${request.kind} failed`, {
      expression, output: output.slice(0, 500),
    })
  }
  const trimmed = stdout.trim()
  if (/^(error|warning):/i.test(trimmed)) {
    throw new HyprscopeError(ErrorCode.COMMAND_FAILED, `dispatch ${request.kind} was refused by the compositor`, {
      expression, output: trimmed.slice(0, 500),
    })
  }
  return trimmed
}
