/** Unknown-field failures name the closest allowed field and show its shape. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OP_FIELDS, OP_SPECS, PREDICATE_SPECS, type PredicateKind, type StepOp } from '../src/plan/model.ts'
import { PlanValidationError, validatePlan } from '../src/plan/validate.ts'

const WINDOW_ID = '0x55a1'

/**
 * Validate one document and return its issues.
 * @param document Candidate plan document.
 * @returns Every recorded issue.
 */
function issuesOf(document: unknown): { path: string; message: string }[] {
  try {
    validatePlan(document)
  } catch (error) {
    assert.ok(error instanceof PlanValidationError)
    return error.issues
  }
  assert.fail('expected the document to be rejected')
}

/**
 * Find one issue by JSON path.
 * @param issues Recorded issues.
 * @param path Expected path.
 * @returns The matching issue.
 */
function issueAt(issues: { path: string; message: string }[], path: string): { path: string; message: string } {
  const issue = issues.find(entry => entry.path === path)
  assert.ok(issue !== undefined, `expected an issue at ${path}, got ${JSON.stringify(issues)}`)
  return issue
}

test('a top-level movePointer x/y hint names at and shows the absolute shape', () => {
  const issues = issuesOf({ version: 1, reason: 'hint', steps: [{ op: 'movePointer', x: 400, y: 300 }] })
  assert.equal(issueAt(issues, '$.steps[0].x').message,
    'unknown field "x"; movePointer takes "at": {"x": 400, "y": 300}')
  assert.equal(issueAt(issues, '$.steps[0].y').message,
    'unknown field "y"; movePointer takes "at": {"x": 400, "y": 300}')
})

test('every step op explains an unknown field with its own catalog name and an example', () => {
  for (const op of Object.keys(OP_SPECS) as StepOp[]) {
    const issues = issuesOf({ version: 1, reason: 'hint', steps: [{ op, bogus: 1 }] })
    const issue = issueAt(issues, '$.steps[0].bogus')
    assert.match(issue.message, /^unknown field "bogus"; /, op)
    assert.ok(issue.message.includes(`${op} takes "`), `${op} hint must name the op: ${issue.message}`)
    assert.ok(!issue.message.endsWith('takes '), `${op} hint must carry an example: ${issue.message}`)
    // Every catalog field has an example, so the suggestion can always show one.
    assert.ok(OP_FIELDS[op].length > 0, `${op} must list at least one field`)
  }
})

test('every non-implicit predicate kind explains an unknown field in requires or expect', () => {
  for (const [kind, spec] of Object.entries(PREDICATE_SPECS) as [PredicateKind, (typeof PREDICATE_SPECS)[PredicateKind]][]) {
    if (spec.implicit) continue
    const document = spec.phases.includes('requires')
      ? { version: 1, reason: 'hint', steps: [{ op: 'assert', requires: [{ kind, bogus: 1 }] }] }
      : {
        version: 1, reason: 'hint',
        steps: [{
          op: 'text', text: 'x',
          requires: [{ kind: 'window.focused', target: { id: WINDOW_ID } }],
          expect: [{ kind, bogus: 1 }],
        }],
      }
    const path = spec.phases.includes('requires')
      ? '$.steps[0].requires[0].bogus'
      : '$.steps[0].expect[0].bogus'
    const issue = issueAt(issuesOf(document), path)
    assert.match(issue.message, /^unknown field "bogus"; /, kind)
    assert.ok(issue.message.includes(`${kind} takes "`), `${kind} hint must name the predicate kind: ${issue.message}`)
  }
})

test('an unknown field nested in a predicate target names the window target shape', () => {
  const issues = issuesOf({
    version: 1, reason: 'hint',
    steps: [{ op: 'assert', requires: [{ kind: 'window.exists', target: { bogus: 1 } }] }],
  })
  assert.match(issueAt(issues, '$.steps[0].requires[0].target.bogus').message,
    /unknown field "bogus"; a window target takes "id": "0x55a1"/)
})

test('unknown fields inside at and capture region shapes are explained too', () => {
  const absolute = issuesOf({ version: 1, reason: 'hint', steps: [{ op: 'movePointer', at: { x: 1, y: 2, z: 3 } }] })
  assert.equal(issueAt(absolute, '$.steps[0].at.z').message,
    'unknown field "z"; an absolute pointer position takes "x": 400')
  const anchored = issuesOf({
    version: 1, reason: 'hint',
    steps: [{ op: 'movePointer', at: { window: { id: WINDOW_ID }, point: [0.5, 0.5], bogus: 1 } }],
  })
  assert.ok(issueAt(anchored, '$.steps[0].at.bogus').message
    .includes('unknown field "bogus"; an anchored pointer destination takes "'))
})

test('an unknown top-level plan field names the plan shape', () => {
  const issues = issuesOf({ version: 1, reason: 'hint', steps: [{ op: 'assert' }], budget: 1 })
  assert.equal(issueAt(issues, '$.budget').message,
    'unknown field "budget"; a plan takes "budgetMs": 8000')
})

test('suggestions are deterministic across repeated validation', () => {
  const document = { version: 1, reason: 'hint', steps: [{ op: 'click', at: { x: 1, y: 2 }, bogus: 1, other: 2 }] }
  assert.deepEqual(issuesOf(document), issuesOf(JSON.parse(JSON.stringify(document))))
})
