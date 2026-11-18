/** Plan text may be one string or per-language variants; receipts keep a string. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describePlanCard } from '../src/plan/card.ts'
import { planTextFor, planTextString, type PlanText } from '../src/plan/model.ts'
import { deriveResumePlan } from '../src/plan/recover.ts'
import { PlanValidationError, summarizePlan, validatePlan } from '../src/plan/validate.ts'

/**
 * Validate one plan document with a pause step.
 * @param extra Top-level fields to merge.
 * @returns Validated plan.
 */
function planOf(extra: Record<string, unknown>) {
  return validatePlan({ version: 1, reason: 'test plan', steps: [{ op: 'pause', ms: 10 }], ...extra })
}

/**
 * Validate one document and return its issues.
 * @param document Candidate plan document.
 * @returns Recorded issues.
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

test('a plain string reason and summary keep the original behavior', () => {
  const plan = planOf({})
  assert.equal(plan.reason, 'test plan')
  assert.equal(plan.summary, null)
  const authored = planOf({ summary: 'focus and type' })
  assert.equal(authored.summary, 'focus and type')
  assert.equal(summarizePlan(authored).summary, 'focus and type')
})

test('plan reason and summary accept per-language variants', () => {
  const plan = planOf({
    reason: { zh: '输入一行', en: 'type one line' },
    summary: { zh: '聚焦并输入', en: 'focus and type' },
  })
  assert.deepEqual(plan.reason, { zh: '输入一行', en: 'type one line' })
  assert.deepEqual(plan.summary, { zh: '聚焦并输入', en: 'focus and type' })
})

test('the consent card renders the variant for its language', () => {
  const plan = planOf({ summary: { zh: '聚焦并输入', en: 'focus and type' } })
  assert.equal(describePlanCard(plan).lines[0], '计划 plan：聚焦并输入')
  assert.equal(describePlanCard(plan, { lang: 'en' }).lines[0], 'Plan plan: focus and type')
})

test('the card falls back to the authored language when one variant is missing', () => {
  const zhOnly = planOf({ summary: { zh: '只有中文' } })
  assert.equal(describePlanCard(zhOnly, { lang: 'en' }).lines[0], 'Plan plan: 只有中文')
  const enOnly = planOf({ summary: { en: 'english only' } })
  assert.equal(describePlanCard(enOnly).lines[0], '计划 plan：english only')
})

test('summaries and reasons resolve to a string, English first then Chinese', () => {
  const both = planOf({ summary: { zh: '中文摘要', en: 'english summary' } })
  assert.equal(summarizePlan(both).summary, 'english summary')
  assert.equal(planTextString(both.reason), 'test plan')
  assert.equal(planTextString({ zh: '中文摘要' } as PlanText), '中文摘要')
  assert.equal(planTextString({ zh: '中文摘要', en: 'english summary' }), 'english summary')
  assert.equal(planTextFor({ zh: '中文摘要' }, 'en'), '中文摘要')
  assert.equal(planTextFor('plain', 'zh'), 'plain')
})

test('a derived recovery plan carries the resolved reason as a string', () => {
  const plan = planOf({ reason: { zh: '输入一行', en: 'type one line' } })
  const outcome = deriveResumePlan({
    plan,
    stepIndex: 0,
    attempt: 1,
    broken: [{ kind: 'window.focused', detail: 'focus moved', target: null, expected: null, observed: null, restorable: true }],
    restoreSteps: [{ op: 'assert' }],
    summary: 'restore focus and continue',
  })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(outcome.plan.reason, 'type one line (recovery 1)')
  assert.equal(outcome.plan.summary, 'restore focus and continue')
})

test('a localized value with no language is rejected', () => {
  const issues = issuesOf({ version: 1, reason: {}, steps: [{ op: 'pause', ms: 10 }] })
  assert.deepEqual(issues.map(issue => issue.path), ['$.reason'])
  assert.match(issues[0]!.message, /expected at least one of "zh" or "en"/)
})

test('a non-string language variant names the language path', () => {
  const issues = issuesOf({ version: 1, reason: { zh: 42 }, steps: [{ op: 'pause', ms: 10 }] })
  assert.ok(issues.some(issue => issue.path === '$.reason.zh' && issue.message === 'expected a string'))
})

test('an unknown language field is rejected with a localized-text hint', () => {
  const issues = issuesOf({ version: 1, reason: { ja: '一行' }, steps: [{ op: 'pause', ms: 10 }] })
  const issue = issues.find(entry => entry.path === '$.reason.ja')
  assert.ok(issue !== undefined)
  assert.match(issue.message, /^unknown field "ja"; localized text takes "zh": "\.\.\."/)
})

test('a malformed reason shape fails with a clear message', () => {
  for (const reason of [3, ['zh'], true]) {
    const issues = issuesOf({ version: 1, reason, steps: [{ op: 'pause', ms: 10 }] })
    assert.ok(issues.some(issue => issue.path === '$.reason'
      && issue.message === 'expected a string or {"zh": "...", "en": "..."}'), JSON.stringify(issues))
  }
})

test('each language variant is bounded separately', () => {
  const long = 'x'.repeat(201)
  const reasonIssues = issuesOf({ version: 1, reason: { en: long }, steps: [{ op: 'pause', ms: 10 }] })
  assert.ok(reasonIssues.some(issue => issue.path === '$.reason.en' && issue.message === 'expected at most 200 characters'))
  const summaryIssues = issuesOf({ version: 1, reason: 'x', summary: { zh: long }, steps: [{ op: 'pause', ms: 10 }] })
  assert.ok(summaryIssues.some(issue => issue.path === '$.summary.zh' && issue.message === 'expected at most 200 characters'))
})

test('an authored document with localized text still canonicalizes stably', () => {
  const document = {
    version: 1, reason: { zh: '输入一行', en: 'type one line' },
    summary: { zh: '聚焦', en: 'focus' }, steps: [{ op: 'pause', ms: 10 }],
  }
  const first = validatePlan(document)
  const second = validatePlan(JSON.parse(JSON.stringify(document)))
  assert.deepEqual(first.reason, second.reason)
  assert.deepEqual(first.summary, second.summary)
})
