/**
 * Plan validation: schema, numeric bounds, and the code-owned predicate and
 * operation tables.
 *
 * Validation is total: every construct an author may write is either accepted
 * with explicit parameters or rejected with a path to the offending field.
 */
import { ErrorCode, HyprscopeError } from '../errors.ts'
import {
  isAbsolutePoint, isAnchorPoint, OP_SPECS, PLAN_LIMITS, PREDICATE_SPECS,
  type AnchorPoint, type AnchorRect, type AbsolutePoint, type EventKind, type Plan, type PlanLineage,
  type PlanStep, type Predicate, type PredicateKind, type StepOp, type WindowTarget,
} from './model.ts'

/** One schema violation, located by a JSON path. */
export interface PlanIssue {
  path: string
  message: string
}

/** Failure raised by {@link validatePlan}. */
export class PlanValidationError extends HyprscopeError {
  readonly issues: PlanIssue[]

  /**
   * @param issues Every violation found in one pass.
   */
  constructor(issues: PlanIssue[]) {
    super(ErrorCode.PLAN_INVALID, `Plan is invalid: ${issues[0]?.message ?? 'unknown reason'}`, { issues })
    this.name = 'PlanValidationError'
    this.issues = issues
  }
}

/** Fields each predicate kind may carry. */
const PREDICATE_FIELDS: Readonly<Record<PredicateKind, readonly string[]>> = {
  'lease.valid': ['kind'],
  'time.budget': ['kind'],
  'no.foreign_event': ['kind'],
  'window.exists': ['kind', 'target'],
  'window.focused': ['kind', 'target'],
  'window.geometry': ['kind', 'target', 'x', 'y', 'width', 'height', 'tol'],
  'window.state': ['kind', 'target', 'floating', 'pinned', 'fullscreen', 'fullscreenClient'],
  'workspace.active': ['kind', 'name'],
  'monitor.config': ['kind', 'name', 'width', 'height', 'scale'],
  'clients.set': ['kind', 'ids'],
  'pointer.position': ['kind', 'target', 'point', 'x', 'y', 'tol'],
  'region.unchanged': ['kind', 'target', 'rect', 'label'],
  'region.changed': ['kind', 'target', 'rect'],
}

/** Fields each step op may carry. */
const STEP_FIELDS: Readonly<Record<StepOp, readonly string[]>> = {
  movePointer: ['op', 'at', 'requires', 'expect'],
  click: ['op', 'at', 'button', 'count', 'requires', 'expect'],
  scroll: ['op', 'value', 'axis', 'requires', 'expect'],
  chord: ['op', 'keys', 'requires', 'expect'],
  text: ['op', 'text', 'requires', 'expect'],
  focusWindow: ['op', 'target', 'requires', 'expect'],
  workspace: ['op', 'name', 'requires', 'expect'],
  moveWindow: ['op', 'target', 'x', 'y', 'requires', 'expect'],
  resizeWindow: ['op', 'target', 'width', 'height', 'requires', 'expect'],
  floatWindow: ['op', 'target', 'floating', 'pinned', 'requires', 'expect'],
  fullscreenWindow: ['op', 'target', 'internal', 'client', 'requires', 'expect'],
  screenshot: ['op', 'label', 'region', 'requires', 'expect'],
  pause: ['op', 'ms', 'requires', 'expect'],
  assert: ['op', 'requires', 'expect'],
  waitEvent: ['op', 'kind', 'timeoutMs', 'requires', 'expect'],
}

/** Address format Hyprland uses for window ids. */
const ADDRESS = /^0x[0-9a-fA-F]+$/

/** Accumulates issues while walking an untrusted plan. */
class Validator {
  readonly issues: PlanIssue[] = []

  /**
   * Record a violation.
   * @param path JSON path.
   * @param message Reason.
   */
  fail(path: string, message: string): void {
    this.issues.push({ path, message })
  }

  /**
   * Accept an object and reject unknown fields.
   * @param value Candidate value.
   * @param path JSON path.
   * @param allowed Fields this shape permits.
   * @returns The record, or null after recording a failure.
   */
  record(value: unknown, path: string, allowed: readonly string[]): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, 'expected an object')
      return null
    }
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) this.fail(`${path}.${key}`, `unknown field "${key}"`)
    }
    return record
  }

  /**
   * Read an optional string.
   * @param value Candidate value.
   * @param path JSON path.
   * @param bounds Length bounds and optional pattern.
   * @returns The string, or null when absent or invalid.
   */
  string(value: unknown, path: string, bounds: { min?: number; max?: number; pattern?: RegExp } = {}): string | null {
    if (value === undefined) return null
    if (typeof value !== 'string') {
      this.fail(path, 'expected a string')
      return null
    }
    const min = bounds.min ?? 0
    const max = bounds.max ?? 512
    if (value.length < min) this.fail(path, `expected at least ${min} characters`)
    if (value.length > max) this.fail(path, `expected at most ${max} characters`)
    if (bounds.pattern !== undefined && !bounds.pattern.test(value)) {
      this.fail(path, `does not match ${String(bounds.pattern)}`)
    }
    return value
  }

  /**
   * Read an optional integer.
   * @param value Candidate value.
   * @param path JSON path.
   * @param bounds Inclusive range and default.
   * @returns The integer, the default when absent, or null when invalid.
   */
  integer(value: unknown, path: string, bounds: { min: number; max: number; fallback?: number }): number | null {
    if (value === undefined) return bounds.fallback ?? null
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      this.fail(path, 'expected an integer')
      return null
    }
    if (value < bounds.min || value > bounds.max) {
      this.fail(path, `expected ${bounds.min}..${bounds.max}`)
      return null
    }
    return value
  }

  /**
   * Read an optional finite number.
   * @param value Candidate value.
   * @param path JSON path.
   * @param bounds Inclusive range.
   * @returns The number, or null when absent or invalid.
   */
  number(value: unknown, path: string, bounds: { min: number; max: number }): number | null {
    if (value === undefined) return null
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.fail(path, 'expected a finite number')
      return null
    }
    if (value < bounds.min || value > bounds.max) {
      this.fail(path, `expected ${bounds.min}..${bounds.max}`)
      return null
    }
    return value
  }

  /**
   * Read an optional boolean.
   * @param value Candidate value.
   * @param path JSON path.
   * @returns The boolean, or null when absent or invalid.
   */
  boolean(value: unknown, path: string): boolean | null {
    if (value === undefined) return null
    if (typeof value !== 'boolean') {
      this.fail(path, 'expected a boolean')
      return null
    }
    return value
  }

  /**
   * Read an optional fullscreen mode.
   * @param value Candidate mode.
   * @param path JSON path.
   * @returns Mode (0 none, 1 fullscreen, 2 maximized), or null when absent or invalid.
   */
  mode(value: unknown, path: string): 0 | 1 | 2 | null {
    if (value === undefined) return null
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2) {
      this.fail(path, 'expected 0 (none), 1 (fullscreen), or 2 (maximized)')
      return null
    }
    return value as 0 | 1 | 2
  }

  /**
   * Validate a window selector.
   * @param value Candidate value.
   * @param path JSON path.
   * @returns Normalized selector, or null when absent or invalid.
   */
  windowTarget(value: unknown, path: string): WindowTarget | null {
    if (value === undefined) return null
    const record = this.record(value, path, ['id', 'app', 'title'])
    if (record === null) return null
    const target: WindowTarget = {}
    const id = this.string(record.id, `${path}.id`, { max: 32, pattern: ADDRESS })
    if (id !== null) target.id = id.toLowerCase()
    const app = this.string(record.app, `${path}.app`, { min: 1, max: 128 })
    if (app !== null) target.app = app
    const title = this.string(record.title, `${path}.title`, { min: 1, max: 256 })
    if (title !== null) target.title = title
    if (target.id === undefined && target.app === undefined && target.title === undefined) {
      this.fail(path, 'expected at least one of id, app, title')
    }
    return target
  }

  /**
   * Validate a unit-space point pair.
   * @param value Candidate value.
   * @param path JSON path.
   * @returns The pair, or null when invalid.
   */
  unitPoint(value: unknown, path: string): [number, number] | null {
    if (!Array.isArray(value) || value.length !== 2) {
      this.fail(path, 'expected [x, y] in 0..1 units')
      return null
    }
    const x = value[0]
    const y = value[1]
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      this.fail(path, 'expected two finite numbers')
      return null
    }
    if (x < 0 || x > 1 || y < 0 || y > 1) this.fail(path, 'expected values in 0..1')
    return [x, y]
  }

  /**
   * Validate a unit-space rectangle.
   * @param value Candidate value.
   * @param path JSON path.
   * @returns The rectangle, or null when invalid.
   */
  unitRect(value: unknown, path: string): [number, number, number, number] | null {
    if (!Array.isArray(value) || value.length !== 4) {
      this.fail(path, 'expected [x, y, width, height] in 0..1 units')
      return null
    }
    const numbers = value.map((entry: unknown) => (typeof entry === 'number' && Number.isFinite(entry) ? entry : null))
    if (numbers.some(entry => entry === null)) {
      this.fail(path, 'expected four finite numbers')
      return null
    }
    const [x, y, width, height] = numbers as [number, number, number, number]
    if (x < 0 || y < 0 || x > 1 || y > 1) this.fail(path, 'origin must be in 0..1')
    if (width <= 0 || height <= 0) this.fail(path, 'size must be positive')
    if (x + width > 1.001 || y + height > 1.001) this.fail(path, 'rectangle must stay inside the window')
    return [x, y, width, height]
  }

  /**
   * Validate a pointer destination.
   * @param value Candidate `at` value.
   * @param path JSON path.
   * @returns Anchored or absolute point, or null when invalid.
   */
  point(value: unknown, path: string): AnchorPoint | AbsolutePoint | null {
    if (value === undefined) return null
    if (isAnchorPoint(value)) {
      const record = this.record(value, path, ['window', 'point'])
      if (record === null) return null
      const window = this.windowTarget(record.window, `${path}.window`)
      const point = this.unitPoint(record.point, `${path}.point`)
      if (window === null || point === null) return null
      return { window, point }
    }
    if (isAbsolutePoint(value)) {
      const x = this.integer((value as AbsolutePoint).x, `${path}.x`, { min: -100_000, max: 100_000 })
      const y = this.integer((value as AbsolutePoint).y, `${path}.y`, { min: -100_000, max: 100_000 })
      if (x === null || y === null) return null
      return { x, y }
    }
    this.fail(path, 'expected an anchored point ({window, point}) or absolute coordinates ({x, y})')
    return null
  }

  /**
   * Validate an anchored region.
   * @param value Candidate region.
   * @param path JSON path.
   * @returns Region, or null when invalid.
   */
  anchorRect(value: unknown, path: string): AnchorRect | null {
    if (value === undefined) return null
    const record = this.record(value, path, ['window', 'rect'])
    if (record === null) return null
    const window = this.windowTarget(record.window, `${path}.window`)
    const rect = this.unitRect(record.rect, `${path}.rect`)
    if (window === null || rect === null) return null
    return { window, rect }
  }

  /**
   * Validate one predicate.
   * @param value Candidate predicate.
   * @param path JSON path.
   * @param phase Which clause the predicate appears in.
   * @returns Normalized predicate, or null when invalid.
   */
  predicate(value: unknown, path: string, phase: 'requires' | 'expect'): Predicate | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, 'expected a predicate object')
      return null
    }
    const kind = (value as { kind?: unknown }).kind
    if (typeof kind !== 'string' || !(kind in PREDICATE_SPECS)) {
      this.fail(`${path}.kind`, `unknown predicate kind ${JSON.stringify(kind)}`)
      return null
    }
    const spec = PREDICATE_SPECS[kind as PredicateKind]
    if (spec.implicit) {
      this.fail(`${path}.kind`, `"${kind}" is implicit and cannot be listed`)
      return null
    }
    if (!spec.phases.includes(phase)) {
      this.fail(path, `"${kind}" is not allowed in ${phase}`)
      return null
    }
    const record = this.record(value, path, PREDICATE_FIELDS[kind as PredicateKind])
    if (record === null) return null
    const predicate: Predicate = { kind: kind as PredicateKind }
    const target = this.windowTarget(record.target, `${path}.target`)
    switch (kind as PredicateKind) {
      case 'window.exists':
      case 'window.focused': {
        if (target === null) this.fail(`${path}.target`, 'required')
        else predicate.target = target
        break
      }
      case 'window.geometry': {
        if (target === null) this.fail(`${path}.target`, 'required')
        else predicate.target = target
        const x = this.integer(record.x, `${path}.x`, { min: -100_000, max: 100_000 })
        const y = this.integer(record.y, `${path}.y`, { min: -100_000, max: 100_000 })
        const width = this.integer(record.width, `${path}.width`, { min: 1, max: 100_000 })
        const height = this.integer(record.height, `${path}.height`, { min: 1, max: 100_000 })
        const tol = this.integer(record.tol, `${path}.tol`, { min: 0, max: 64, fallback: 0 })
        const present = [x, y, width, height].filter(entry => entry !== null).length
        if (present !== 0 && present !== 4) {
          this.fail(path, 'geometry needs all of x, y, width, height, or none to compare with the run baseline')
        } else if (present === 4) {
          predicate.x = x!
          predicate.y = y!
          predicate.width = width!
          predicate.height = height!
        }
        predicate.tol = tol ?? 0
        break
      }
      case 'window.state': {
        if (target === null) this.fail(`${path}.target`, 'required')
        else predicate.target = target
        const floating = this.boolean(record.floating, `${path}.floating`)
        const pinned = this.boolean(record.pinned, `${path}.pinned`)
        const fullscreen = this.mode(record.fullscreen, `${path}.fullscreen`)
        const fullscreenClient = this.mode(record.fullscreenClient, `${path}.fullscreenClient`)
        if (floating === null && pinned === null && fullscreen === null && fullscreenClient === null) {
          this.fail(path, 'expected at least one of floating, pinned, fullscreen, fullscreenClient')
        }
        if (floating !== null) predicate.floating = floating
        if (pinned !== null) predicate.pinned = pinned
        if (fullscreen !== null) predicate.fullscreen = fullscreen
        if (fullscreenClient !== null) predicate.fullscreenClient = fullscreenClient
        break
      }
      case 'workspace.active': {
        const name = this.string(record.name, `${path}.name`, { min: 1, max: 32, pattern: /^[A-Za-z0-9._-]+$/ })
        if (name === null) this.fail(`${path}.name`, 'required')
        else predicate.name = name
        break
      }
      case 'monitor.config': {
        const name = this.string(record.name, `${path}.name`, { min: 1, max: 64 })
        if (name === null) this.fail(`${path}.name`, 'required')
        if (name !== null) predicate.name = name
        const width = this.integer(record.width, `${path}.width`, { min: 1, max: 100_000 })
        const height = this.integer(record.height, `${path}.height`, { min: 1, max: 100_000 })
        const scale = this.number(record.scale, `${path}.scale`, { min: 0.1, max: 8 })
        if (width === null && height === null && scale === null) {
          this.fail(path, 'expected at least one of width, height, scale')
        }
        if (width !== null) predicate.width = width
        if (height !== null) predicate.height = height
        if (scale !== null) predicate.scale = scale
        break
      }
      case 'clients.set': {
        const ids = record.ids
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > 256) {
          this.fail(`${path}.ids`, 'expected a non-empty array of window addresses')
        } else {
          const normalized: string[] = []
          for (const [index, entry] of ids.entries()) {
            const id = this.string(entry, `${path}.ids[${index}]`, { max: 32, pattern: ADDRESS })
            if (id !== null) normalized.push(id.toLowerCase())
          }
          predicate.ids = normalized
        }
        break
      }
      case 'pointer.position': {
        predicate.tol = this.integer(record.tol, `${path}.tol`, { min: 0, max: 256, fallback: 2 }) ?? 2
        if (target !== null) {
          predicate.target = target
          const point = this.unitPoint(record.point, `${path}.point`)
          if (point === null) this.fail(`${path}.point`, 'required when target is set')
          else predicate.point = point
          if (record.x !== undefined || record.y !== undefined) {
            this.fail(path, 'a window-relative pointer premise cannot also carry absolute x/y')
          }
          break
        }
        const x = this.integer(record.x, `${path}.x`, { min: -100_000, max: 100_000 })
        const y = this.integer(record.y, `${path}.y`, { min: -100_000, max: 100_000 })
        if (x === null) this.fail(`${path}.x`, 'required')
        if (y === null) this.fail(`${path}.y`, 'required')
        if (x !== null) predicate.x = x
        if (y !== null) predicate.y = y
        if (record.point !== undefined) this.fail(`${path}.point`, 'point requires a target')
        break
      }
      case 'region.unchanged': {
        if (target === null) this.fail(`${path}.target`, 'required')
        else predicate.target = target
        const rect = this.unitRect(record.rect, `${path}.rect`)
        if (rect === null) this.fail(`${path}.rect`, 'required')
        else predicate.rect = rect
        const label = this.string(record.label, `${path}.label`, { max: 40, pattern: /^[A-Za-z0-9._-]+$/ })
        if (label !== null) predicate.label = label
        break
      }
      case 'region.changed': {
        if (target === null) this.fail(`${path}.target`, 'required')
        else predicate.target = target
        const rect = this.unitRect(record.rect, `${path}.rect`)
        if (rect === null) this.fail(`${path}.rect`, 'required')
        else predicate.rect = rect
        break
      }
      default:
        this.fail(path, `unhandled predicate kind "${String(kind)}"`)
        return null
    }
    return predicate
  }

  /**
   * Validate a predicate list.
   * @param value Candidate list.
   * @param path JSON path.
   * @param phase Clause being validated.
   * @returns Normalized list.
   */
  predicates(value: unknown, path: string, phase: 'requires' | 'expect'): Predicate[] {
    if (value === undefined) return []
    if (!Array.isArray(value)) {
      this.fail(path, 'expected an array')
      return []
    }
    if (value.length > 16) this.fail(path, 'expected at most 16 predicates')
    const list: Predicate[] = []
    for (const [index, entry] of value.entries()) {
      const predicate = this.predicate(entry, `${path}[${index}]`, phase)
      if (predicate !== null) list.push(predicate)
    }
    return list
  }

  /**
   * Validate one step.
   * @param value Candidate step.
   * @param path JSON path.
   * @returns Normalized step (fields may be incomplete when validation failed).
   */
  step(value: unknown, path: string): PlanStep {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, 'expected an object')
      return { op: 'assert', requires: [] }
    }
    const opValue = (value as { op?: unknown }).op
    if (typeof opValue !== 'string' || !(opValue in OP_SPECS)) {
      this.fail(`${path}.op`, `unknown op ${JSON.stringify(opValue)}`)
      return { op: 'assert', requires: [] }
    }
    const op = opValue as StepOp
    const spec = OP_SPECS[op]
    const record = this.record(value, path, STEP_FIELDS[op])
    if (record === null) return { op, requires: [] }
    const step: PlanStep = { op }
    const requires = this.predicates(record.requires, `${path}.requires`, 'requires')
    const expect = this.predicates(record.expect, `${path}.expect`, 'expect')
    if (requires.length > 0) step.requires = requires
    if (expect.length > 0) step.expect = expect
    if (spec.requiresDeclared && requires.length === 0) {
      this.fail(`${path}.requires`, `op "${op}" must declare at least one precondition`)
    }
    if (spec.requiresExpect && expect.length === 0) {
      this.fail(`${path}.expect`, `op "${op}" is not idempotent and must declare at least one expectation`)
    }
    for (const kind of spec.requiredKinds ?? []) {
      if (!requires.some(predicate => predicate.kind === kind)) {
        this.fail(`${path}.requires`, `op "${op}" must declare a "${kind}" precondition`)
      }
    }
    const unchangedRects = new Set(requires
      .filter(predicate => predicate.kind === 'region.unchanged')
      .map(predicate => JSON.stringify([predicate.target ?? null, predicate.rect ?? null])))
    for (const predicate of expect) {
      if (predicate.kind !== 'region.changed') continue
      const key = JSON.stringify([predicate.target ?? null, predicate.rect ?? null])
      if (unchangedRects.has(key)) {
        this.fail(`${path}.expect`, 'the same region cannot be both unchanged and changed in one step')
      }
    }
    switch (op) {
      case 'movePointer':
      case 'click': {
        const at = this.point(record.at, `${path}.at`)
        if (at === null) this.fail(`${path}.at`, 'required')
        else step.at = at
        if (op === 'click') {
          const button = record.button
          if (button === undefined) step.button = 'left'
          else if (button === 'left' || button === 'right' || button === 'middle' || button === 'back' || button === 'forward') {
            step.button = button
          } else {
            this.fail(`${path}.button`, 'expected left, right, middle, back, or forward')
          }
          step.count = this.integer(record.count, `${path}.count`, { min: 1, max: 2, fallback: 1 }) ?? 1
        }
        break
      }
      case 'scroll': {
        const value = this.number(record.value, `${path}.value`, { min: -1_000, max: 1_000 })
        if (value === null) this.fail(`${path}.value`, 'required')
        else step.value = value
        const axis = record.axis
        if (axis === 'vertical' || axis === 'horizontal') step.axis = axis
        else this.fail(`${path}.axis`, 'expected vertical or horizontal')
        break
      }
      case 'chord': {
        const keys = record.keys
        if (!Array.isArray(keys) || keys.length === 0 || keys.length > 5) {
          this.fail(`${path}.keys`, 'expected 1..5 key names')
        } else {
          const normalized: string[] = []
          for (const [index, entry] of keys.entries()) {
            const key = this.string(entry, `${path}.keys[${index}]`, { min: 1, max: 16, pattern: /^[A-Za-z0-9_+.-]+$/ })
            if (key !== null) normalized.push(key)
          }
          step.keys = normalized
        }
        break
      }
      case 'text': {
        const text = this.string(record.text, `${path}.text`, { min: 1, max: PLAN_LIMITS.maxSingleTextChars })
        if (text === null) this.fail(`${path}.text`, 'required')
        else step.text = text
        break
      }
      case 'focusWindow': {
        const target = this.windowTarget(record.target, `${path}.target`)
        if (target === null) this.fail(`${path}.target`, 'required')
        else step.target = target
        break
      }
      case 'workspace': {
        const name = this.string(record.name, `${path}.name`, { min: 1, max: 32, pattern: /^[A-Za-z0-9._-]+$/ })
        if (name === null) this.fail(`${path}.name`, 'required')
        else step.name = name
        break
      }
      case 'moveWindow': {
        const target = this.windowTarget(record.target, `${path}.target`)
        if (target === null) this.fail(`${path}.target`, 'required')
        else step.target = target
        const x = this.integer(record.x, `${path}.x`, { min: -100_000, max: 100_000 })
        const y = this.integer(record.y, `${path}.y`, { min: -100_000, max: 100_000 })
        if (x === null) this.fail(`${path}.x`, 'required')
        if (y === null) this.fail(`${path}.y`, 'required')
        if (x !== null) step.x = x
        if (y !== null) step.y = y
        break
      }
      case 'floatWindow': {
        const target = this.windowTarget(record.target, `${path}.target`)
        if (target === null) this.fail(`${path}.target`, 'required')
        else step.target = target
        const floating = this.boolean(record.floating, `${path}.floating`)
        const pinned = this.boolean(record.pinned, `${path}.pinned`)
        if (floating === null && pinned === null) this.fail(path, 'expected at least one of floating, pinned')
        if (floating !== null) step.floating = floating
        if (pinned !== null) step.pinned = pinned
        break
      }
      case 'resizeWindow': {
        const target = this.windowTarget(record.target, `${path}.target`)
        if (target === null) this.fail(`${path}.target`, 'required')
        else step.target = target
        const width = this.integer(record.width, `${path}.width`, { min: 1, max: 100_000 })
        const height = this.integer(record.height, `${path}.height`, { min: 1, max: 100_000 })
        if (width === null) this.fail(`${path}.width`, 'required')
        if (height === null) this.fail(`${path}.height`, 'required')
        if (width !== null) step.width = width
        if (height !== null) step.height = height
        break
      }
      case 'fullscreenWindow': {
        const target = this.windowTarget(record.target, `${path}.target`)
        if (target === null) this.fail(`${path}.target`, 'required')
        else step.target = target
        step.internal = this.mode(record.internal, `${path}.internal`) ?? 0
        step.client = this.mode(record.client, `${path}.client`) ?? 0
        break
      }
      case 'screenshot': {
        const label = this.string(record.label, `${path}.label`, { max: 40, pattern: /^[A-Za-z0-9._-]+$/ })
        if (label !== null) step.label = label
        const region = this.anchorRect(record.region, `${path}.region`)
        if (region !== null) step.region = region
        break
      }
      case 'pause': {
        const ms = this.integer(record.ms, `${path}.ms`, { min: 1, max: PLAN_LIMITS.maxPauseMs })
        if (ms === null) this.fail(`${path}.ms`, 'required')
        else step.ms = ms
        break
      }
      case 'assert':
        if (expect.length > 0) this.fail(`${path}.expect`, 'assert does not commit, so it cannot expect')
        break
      case 'waitEvent': {
        const kind = record.kind
        const kinds: readonly EventKind[] = ['activewindow', 'workspace', 'openwindow', 'closewindow']
        if (typeof kind === 'string' && (kinds as readonly string[]).includes(kind)) {
          step.kind = kind as EventKind
        } else {
          this.fail(`${path}.kind`, 'expected activewindow, workspace, openwindow, or closewindow')
        }
        step.timeoutMs = this.integer(record.timeoutMs, `${path}.timeoutMs`, {
          min: 100, max: PLAN_LIMITS.maxWaitEventMs, fallback: PLAN_LIMITS.defaultWaitEventMs,
        }) ?? PLAN_LIMITS.defaultWaitEventMs
        break
      }
      default:
        this.fail(path, `unhandled op ${String(op)}`)
    }
    return step
  }

  /**
   * Validate the recovery lineage a derived plan carries.
   * @param value Candidate lineage.
   * @returns Lineage, or undefined when invalid.
   */
  lineage(value: unknown): PlanLineage | undefined {
    const record = this.record(value, '$.lineage', ['rootPlanId', 'attempt', 'interruptedAtStep', 'broken'])
    if (record === null) return undefined
    const rootPlanId = this.string(record.rootPlanId, '$.lineage.rootPlanId', { min: 1, max: 64, pattern: /^[A-Za-z0-9._-]+$/ })
    const attempt = this.integer(record.attempt, '$.lineage.attempt', { min: 1, max: PLAN_LIMITS.maxResumes })
    const interruptedAtStep = this.integer(record.interruptedAtStep, '$.lineage.interruptedAtStep', { min: 0, max: PLAN_LIMITS.maxSteps })
    const brokenRaw = record.broken
    const broken: string[] = []
    if (!Array.isArray(brokenRaw) || brokenRaw.length === 0 || brokenRaw.length > 16) {
      this.fail('$.lineage.broken', 'expected a non-empty array of premise kinds')
    } else {
      for (const [index, entry] of brokenRaw.entries()) {
        const kind = this.string(entry, `$.lineage.broken[${index}]`, { min: 1, max: 32, pattern: /^[A-Za-z0-9._-]+$/ })
        if (kind !== null) broken.push(kind)
      }
    }
    if (rootPlanId === null || attempt === null || interruptedAtStep === null) return undefined
    return { rootPlanId, attempt, interruptedAtStep, broken }
  }
}

/**
 * Validate an untrusted plan document.
 * @param input Parsed JSON value.
 * @returns Normalized plan with defaults applied.
 * @throws PlanValidationError listing every issue.
 */
export function validatePlan(input: unknown, options: ValidateOptions = {}): Plan {
  const validator = new Validator()
  const root = validator.record(input, '$', [
    'version', 'id', 'reason', 'summary', 'workspace', 'budgetMs', 'settleMs', 'interferencePromptMs', 'steps', 'lineage',
  ])
  if (root === null) throw new PlanValidationError(validator.issues)
  if (root.version !== 1) validator.fail('$.version', 'expected 1')
  const reason = validator.string(root.reason, '$.reason', { min: 1, max: 200 })
  if (reason === null) validator.fail('$.reason', 'required')
  const id = validator.string(root.id, '$.id', { max: 64, pattern: /^[A-Za-z0-9._-]+$/ })
  // An explicit null is the same as an absent optional field; the derived
  // recovery plans preserve the original document's omission this way.
  const summary = root.summary === null ? null : validator.string(root.summary, '$.summary', { max: 200 })
  const workspace = root.workspace === null ? null : validator.string(root.workspace, '$.workspace', { min: 1, max: 32, pattern: /^[A-Za-z0-9._-]+$/ })
  const budgetMs = validator.integer(root.budgetMs, '$.budgetMs', {
    min: PLAN_LIMITS.minBudgetMs, max: PLAN_LIMITS.maxBudgetMs, fallback: PLAN_LIMITS.defaultBudgetMs,
  })
  const settleMs = validator.integer(root.settleMs, '$.settleMs', {
    min: PLAN_LIMITS.minSettleMs, max: PLAN_LIMITS.maxSettleMs, fallback: PLAN_LIMITS.defaultSettleMs,
  })
  const interferencePromptMs = validator.integer(root.interferencePromptMs, '$.interferencePromptMs', {
    min: PLAN_LIMITS.minInterferencePromptMs,
    max: PLAN_LIMITS.maxInterferencePromptMs,
    fallback: PLAN_LIMITS.defaultInterferencePromptMs,
  })
  const rawSteps = root.steps
  const steps: PlanStep[] = []
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    validator.fail('$.steps', 'expected a non-empty array')
  } else {
    if (rawSteps.length > PLAN_LIMITS.maxSteps) {
      validator.fail('$.steps', `expected at most ${PLAN_LIMITS.maxSteps} steps`)
    }
    for (const [index, entry] of rawSteps.entries()) {
      steps.push(validator.step(entry, `$.steps[${index}]`))
    }
  }
  const textChars = steps.reduce((total, step) => total + (step.text?.length ?? 0), 0)
  if (textChars > PLAN_LIMITS.maxTextChars) {
    validator.fail('$.steps', `total typed text must stay under ${PLAN_LIMITS.maxTextChars} characters`)
  }
  let lineage: PlanLineage | undefined
  if (root.lineage !== undefined) {
    if (options.allowLineage !== true) {
      validator.fail('$.lineage', 'only the tool may derive a plan with a lineage')
    } else {
      lineage = validator.lineage(root.lineage)
    }
  }
  if (validator.issues.length > 0) throw new PlanValidationError(validator.issues)
  const plan: Plan = {
    version: 1,
    id: id ?? 'plan',
    reason: reason ?? '',
    summary: summary ?? null,
    workspace: workspace ?? null,
    budgetMs: budgetMs ?? PLAN_LIMITS.defaultBudgetMs,
    settleMs: settleMs ?? PLAN_LIMITS.defaultSettleMs,
    interferencePromptMs: interferencePromptMs ?? PLAN_LIMITS.defaultInterferencePromptMs,
    steps,
  }
  if (lineage !== undefined) plan.lineage = lineage
  return plan
}

/** Options for {@link validatePlan}. */
export interface ValidateOptions {
  /** Accept the recovery lineage only the tool may attach. */
  allowLineage?: boolean
}

/** Consent-card summary derived from a validated plan. */
export interface PlanSummary {
  steps: number
  ops: string[]
  workspace: string | null
  summary: string | null
}

/**
 * Summarize a plan for the consent card.
 * @param plan Validated plan.
 * @returns Counts, unique ops, and the authored summary.
 */
export function summarizePlan(plan: Plan): PlanSummary {
  const seen = new Set<string>()
  for (const step of plan.steps) seen.add(step.op)
  return {
    steps: plan.steps.length,
    ops: [...seen],
    workspace: plan.workspace,
    summary: plan.summary,
  }
}
