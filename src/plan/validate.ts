/**
 * Plan validation: schema, numeric bounds, and the code-owned predicate and
 * operation tables.
 *
 * Validation is total: every construct an author may write is either accepted
 * with explicit parameters or rejected with a path to the offending field.
 */
import { ErrorCode, HyprscopeError } from '../errors.ts'
import {
  isAbsolutePoint, isAnchorPoint, OP_FIELDS, OP_SPECS, PLAN_LIMITS, planTextString, PREDICATE_SPECS,
  type AnchorPoint, type AnchorRect, type AbsolutePoint, type EventKind, type Plan, type PlanLineage,
  type PlanStep, type PlanText, type Predicate, type PredicateKind, type StepOp, type WindowTarget,
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

/** Fields each step op may carry, derived from the field catalog the CLI prints. */
const STEP_FIELDS: Readonly<Record<StepOp, readonly string[]>> = Object.fromEntries(
  (Object.keys(OP_FIELDS) as StepOp[]).map(op => [op, ['op', ...OP_FIELDS[op].map(field => field.name)]]),
) as unknown as Readonly<Record<StepOp, readonly string[]>>

/**
 * One example per allowed field, used to make an unknown-field failure
 * actionable: the message names the closest allowed field and shows its shape.
 */
interface ShapeHint {
  /** What the enclosing value is, e.g. `movePointer` or `a window target`. */
  subject: string
  /** Rendered JSON member per allowed field. */
  examples: Readonly<Record<string, string>>
  /** Shape-naming fields that are only suggested when they are clearly closest. */
  generic?: readonly string[]
}

const WINDOW_TARGET_HINT: ShapeHint = {
  subject: 'a window target',
  examples: { id: '"id": "0x55a1"', app: '"app": "foot"', title: '"title": "demo"' },
}

const ANCHORED_POINT_HINT: ShapeHint = {
  subject: 'an anchored pointer destination',
  examples: { window: '"window": {"app": "foot"}', point: '"point": [0.5, 0.5]' },
}

const ABSOLUTE_POINT_HINT: ShapeHint = {
  subject: 'an absolute pointer position',
  examples: { x: '"x": 400', y: '"y": 300' },
}

const REGION_HINT: ShapeHint = {
  subject: 'a capture region',
  examples: {
    window: '"window": {"app": "foot"}',
    rect: '"rect": [0, 0, 1, 1]',
  },
}

const LOCALIZED_TEXT_HINT: ShapeHint = {
  subject: 'localized text',
  examples: { zh: '"zh": "..."', en: '"en": "..."' },
}

const LINEAGE_HINT: ShapeHint = {
  subject: 'a plan lineage',
  examples: {
    rootPlanId: '"rootPlanId": "plan"',
    attempt: '"attempt": 1',
    interruptedAtStep: '"interruptedAtStep": 0',
    broken: '"broken": ["window.focused"]',
  },
}

const PLAN_HINT: ShapeHint = {
  subject: 'a plan',
  examples: {
    version: '"version": 1',
    id: '"id": "plan"',
    reason: '"reason": "type one line into the terminal"',
    summary: '"summary": "focus, click, type, capture"',
    workspace: '"workspace": "2"',
    budgetMs: '"budgetMs": 8000',
    settleMs: '"settleMs": 600',
    interferencePromptMs: '"interferencePromptMs": 12000',
    steps: '"steps": [{"op": "assert"}]',
    lineage: '"lineage": {"rootPlanId": "plan", "attempt": 1, "interruptedAtStep": 0, "broken": ["window.focused"]}',
  },
}

/**
 * Build one predicate hint: the subject is the kind name and `kind` is generic.
 * @param kind Predicate kind.
 * @param examples Example member per allowed field.
 * @returns Hint used when the predicate object carries an unknown field.
 */
function predicateHint(kind: PredicateKind, examples: Record<string, string>): ShapeHint {
  return { subject: kind, examples, generic: ['kind'] }
}

/** Example member per allowed predicate field, for every catalog kind. */
const PREDICATE_HINTS: Readonly<Record<PredicateKind, ShapeHint>> = {
  'lease.valid': predicateHint('lease.valid', { kind: '"kind": "lease.valid"' }),
  'time.budget': predicateHint('time.budget', { kind: '"kind": "time.budget"' }),
  'no.foreign_event': predicateHint('no.foreign_event', { kind: '"kind": "no.foreign_event"' }),
  'window.exists': predicateHint('window.exists', {
    kind: '"kind": "window.exists"',
    target: '"target": {"app": "foot"}',
  }),
  'window.focused': predicateHint('window.focused', {
    kind: '"kind": "window.focused"',
    target: '"target": {"app": "foot"}',
  }),
  'window.geometry': predicateHint('window.geometry', {
    kind: '"kind": "window.geometry"',
    target: '"target": {"app": "foot"}',
    x: '"x": 100',
    y: '"y": 100',
    width: '"width": 800',
    height: '"height": 600',
    tol: '"tol": 2',
  }),
  'window.state': predicateHint('window.state', {
    kind: '"kind": "window.state"',
    target: '"target": {"app": "foot"}',
    floating: '"floating": true',
    pinned: '"pinned": false',
    fullscreen: '"fullscreen": 1',
    fullscreenClient: '"fullscreenClient": 0',
  }),
  'workspace.active': predicateHint('workspace.active', {
    kind: '"kind": "workspace.active"',
    name: '"name": "2"',
  }),
  'monitor.config': predicateHint('monitor.config', {
    kind: '"kind": "monitor.config"',
    name: '"name": "DP-1"',
    width: '"width": 2560',
    height: '"height": 1440',
    scale: '"scale": 1',
  }),
  'clients.set': predicateHint('clients.set', {
    kind: '"kind": "clients.set"',
    ids: '"ids": ["0x55a1"]',
  }),
  'pointer.position': predicateHint('pointer.position', {
    kind: '"kind": "pointer.position"',
    target: '"target": {"app": "foot"}',
    point: '"point": [0.5, 0.5]',
    x: '"x": 400',
    y: '"y": 300',
    tol: '"tol": 2',
  }),
  'region.unchanged': predicateHint('region.unchanged', {
    kind: '"kind": "region.unchanged"',
    target: '"target": {"app": "foot"}',
    rect: '"rect": [0, 0, 1, 1]',
    label: '"label": "panel"',
  }),
  'region.changed': predicateHint('region.changed', {
    kind: '"kind": "region.changed"',
    target: '"target": {"app": "foot"}',
    rect: '"rect": [0, 0, 1, 1]',
  }),
}

/**
 * Build the hint for one step op: every field it accepts, plus the two clauses.
 * @param op Operation being validated.
 * @returns Hint used when the step carries an unknown field.
 */
function stepHint(op: StepOp): ShapeHint {
  const examples: Record<string, string> = { op: '"op": "' + op + '"' }
  for (const field of OP_FIELDS[op]) examples[field.name] = field.example
  return { subject: op, examples, generic: ['op', 'requires', 'expect'] }
}

/**
 * Levenshtein edit distance between two short field names.
 * @param left First string.
 * @param right Second string.
 * @returns Number of single-character insertions, deletions, or substitutions.
 */
function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_unused, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0]!
    previous[0] = row
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column]!
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      previous[column] = Math.min(previous[column - 1]! + 1, above + 1, diagonal + cost)
      diagonal = above
    }
  }
  return previous[right.length]!
}

/**
 * Pick the allowed field that best explains an unknown one.
 * A parameter field wins over a shape-naming field unless the shape-naming
 * field is at least two edits closer, so a stray top-level `x` on movePointer
 * is explained by `at` rather than by `op`, while a `require` typo is still
 * explained by `requires`.
 * @param unknown Unknown field name.
 * @param allowed Fields the shape accepts.
 * @param hint Examples and generic fields for that shape.
 * @returns Best field, or null when no allowed field has an example.
 */
function closestField(unknown: string, allowed: readonly string[], hint: ShapeHint): string | null {
  const generic = hint.generic ?? []
  const candidates = allowed.flatMap((field, index) => hint.examples[field] === undefined
    ? []
    : [{ field, index, distance: editDistance(unknown, field), generic: generic.includes(field) }])
  candidates.sort((left, right) => left.distance - right.distance
    || Number(left.generic) - Number(right.generic)
    || left.index - right.index)
  const specific = candidates.find(candidate => !candidate.generic)
  const shapeField = candidates[0]
  if (specific === undefined) return shapeField?.field ?? null
  if (shapeField !== undefined && shapeField.generic && shapeField.distance + 1 < specific.distance) {
    return shapeField.field
  }
  return specific.field
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
   * Accept an object and reject unknown fields with an actionable hint.
   * @param value Candidate value.
   * @param path JSON path.
   * @param allowed Fields this shape permits.
   * @param hint Subject and example member per allowed field.
   * @returns The record, or null after recording a failure.
   */
  record(value: unknown, path: string, allowed: readonly string[], hint: ShapeHint): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, 'expected an object')
      return null
    }
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record)) {
      if (allowed.includes(key)) continue
      const closest = closestField(key, allowed, hint)
      const example = closest === null ? undefined : hint.examples[closest]
      this.fail(`${path}.${key}`, example === undefined
        ? `unknown field "${key}"`
        : `unknown field "${key}"; ${hint.subject} takes ${example}`)
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
   * Read authored human text: a plain string, or per-language variants.
   * @param value Candidate value.
   * @param path JSON path.
   * @param bounds Length bounds applied to every language variant.
   * @returns The text, or null when absent or invalid.
   */
  localizedText(
    value: unknown, path: string, bounds: { min?: number; max?: number; pattern?: RegExp } = {},
  ): PlanText | null {
    if (value === undefined) return null
    if (typeof value === 'string') return this.string(value, path, bounds)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, 'expected a string or {"zh": "...", "en": "..."}')
      return null
    }
    const record = this.record(value, path, ['zh', 'en'], LOCALIZED_TEXT_HINT)
    if (record === null) return null
    const text: { zh?: string; en?: string } = {}
    let present = 0
    for (const lang of ['zh', 'en'] as const) {
      if (record[lang] === undefined) continue
      const entry = this.string(record[lang], `${path}.${lang}`, bounds)
      if (entry === null) continue
      text[lang] = entry
      present += 1
    }
    if (present === 0) {
      this.fail(path, 'expected at least one of "zh" or "en"')
      return null
    }
    return text
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
    const record = this.record(value, path, ['id', 'app', 'title'], WINDOW_TARGET_HINT)
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
      const record = this.record(value, path, ['window', 'point'], ANCHORED_POINT_HINT)
      if (record === null) return null
      const window = this.windowTarget(record.window, `${path}.window`)
      const point = this.unitPoint(record.point, `${path}.point`)
      if (window === null || point === null) return null
      return { window, point }
    }
    if (isAbsolutePoint(value)) {
      const record = this.record(value, path, ['x', 'y'], ABSOLUTE_POINT_HINT)
      if (record === null) return null
      const x = this.integer(record.x, `${path}.x`, { min: -100_000, max: 100_000 })
      const y = this.integer(record.y, `${path}.y`, { min: -100_000, max: 100_000 })
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
    const record = this.record(value, path, ['window', 'rect'], REGION_HINT)
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
    const record = this.record(value, path, PREDICATE_FIELDS[kind as PredicateKind], PREDICATE_HINTS[kind as PredicateKind])
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
    const record = this.record(value, path, STEP_FIELDS[op], stepHint(op))
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
        const window = this.windowTarget(record.window, `${path}.window`)
        if (window !== null) step.window = window
        if (region !== null && window !== null) {
          this.fail(`${path}.window`, 'a screenshot captures either a region or a window, not both')
        }
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
    const record = this.record(value, '$.lineage', ['rootPlanId', 'attempt', 'interruptedAtStep', 'broken'], LINEAGE_HINT)
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
  ], PLAN_HINT)
  if (root === null) throw new PlanValidationError(validator.issues)
  if (root.version !== 1) validator.fail('$.version', 'expected 1')
  // reason and summary accept either one string (the original shape) or
  // per-language variants; validation bounds every variant separately.
  const reason = validator.localizedText(root.reason, '$.reason', { min: 1, max: 200 })
  if (root.reason === undefined) validator.fail('$.reason', 'required')
  const id = validator.string(root.id, '$.id', { max: 64, pattern: /^[A-Za-z0-9._-]+$/ })
  // An explicit null is the same as an absent optional field; the derived
  // recovery plans preserve the original document's omission this way.
  const summary = root.summary === null || root.summary === undefined
    ? null
    : validator.localizedText(root.summary, '$.summary', { max: 200 })
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
  // The receipt keeps a string: a localized summary resolves to English first,
  // then Chinese, so a consumer never has to understand the authored shape.
  return {
    steps: plan.steps.length,
    ops: [...seen],
    workspace: plan.workspace,
    summary: plan.summary === null ? null : planTextString(plan.summary),
  }
}
