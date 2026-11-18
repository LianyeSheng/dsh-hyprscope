/**
 * Operation reference for `hyprscope control ops`.
 *
 * Every line is derived from the same code-owned tables validation and the
 * executor use (`OP_SPECS` and `OP_FIELDS`), so the CLI reference, the
 * validator, and the documentation cannot disagree about what an op accepts.
 */
import type { CapabilityId } from '../compat/types.ts'
import { OP_FIELDS, OP_SPECS, type StepOp } from './model.ts'

/** One field of an operation, as the CLI reports it. */
export interface OpFieldInfo {
  /** Field name as written in a step. */
  name: string
  /** Whether a step must carry the field. */
  required: boolean
  /** One-line shape hint, or `forbidden` for a field the op rejects. */
  shape: string
}

/** One operation, as the CLI reports it. */
export interface OpInfo {
  /** Operation name, also the `op` member of a step. */
  op: StepOp
  /** Whether the op changes desktop state. */
  mutating: boolean
  /** Whether applying it twice equals applying it once. */
  idempotent: boolean
  /** Whether the step must name a target window. */
  needsTarget: boolean
  /** Capabilities the op itself needs from the accepted baseline. */
  requires: CapabilityId[]
  /** Every field a step of this op may carry, in catalog order. */
  fields: OpFieldInfo[]
}

/**
 * List every supported operation and its fields.
 * @returns Stable catalog order (the order of `OP_SPECS`), with plain JSON values.
 */
export function listOps(): OpInfo[] {
  return (Object.keys(OP_SPECS) as StepOp[]).map(op => {
    const spec = OP_SPECS[op]
    return {
      op,
      mutating: spec.mutating,
      idempotent: spec.idempotent,
      needsTarget: spec.needsTarget,
      requires: [...spec.requires],
      fields: OP_FIELDS[op].map(field => ({ name: field.name, required: field.required, shape: field.shape })),
    }
  })
}

/**
 * Render one operation as a single reference line.
 * @param info Operation catalog entry.
 * @returns A line such as `movePointer · needs none · requires inject.pointer · at:{x,y} [requires?, expect?]`.
 */
export function renderOpsLine(info: OpInfo): string {
  const required: string[] = []
  const optional: string[] = []
  const requiredPredicates: string[] = []
  for (const field of info.fields) {
    if (field.shape === 'forbidden') {
      optional.push(`${field.name}:forbidden`)
      continue
    }
    const predicate = field.name === 'requires' || field.name === 'expect'
    if (predicate && field.required) {
      requiredPredicates.push(field.name)
      continue
    }
    if (predicate) {
      optional.push(`${field.name}?`)
      continue
    }
    if (field.required) required.push(`${field.name}:${field.shape}`)
    else optional.push(`${field.name}?:${field.shape}`)
  }
  const clauses = [...required, ...requiredPredicates]
  if (optional.length > 0) clauses.push(`[${optional.join(', ')}]`)
  const needs = info.needsTarget ? 'window' : 'none'
  const requires = info.requires.length === 0 ? 'none' : info.requires.join(' ')
  return `${info.op} · needs ${needs} · requires ${requires} · ${clauses.join(' ')}`
}

/**
 * Render the whole catalog as one line per op.
 * @returns Human-readable operation reference.
 */
export function renderOps(): string {
  return listOps().map(renderOpsLine).join('\n')
}
