/** Capability catalog invariants and the baseline reader's narrowing rules. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { BASELINE_SCHEMA, emptyFingerprint, readBaseline } from '../src/compat/baseline.ts'
import { CAPABILITY_IDS, CAPABILITY_SPECS, isCapabilityId, RESTORE_CAPABILITIES } from '../src/compat/catalog.ts'
import { missingRequiredIssues } from '../src/compat/gate.ts'
import type {
  BaselineDocument, BaselineState, CapabilityCheck, CapabilityEntry, CapabilityId, CapabilityLevel,
  CapabilityStatus, EvidenceLevel,
} from '../src/compat/types.ts'
import { OP_SPECS, PREDICATE_SPECS } from '../src/plan/model.ts'

const APPROVED_AT = '2026-11-17T22:00:00.000Z'

/** Verdict fields a fixture may replace for one capability. */
interface EntryOverrides {
  level?: CapabilityLevel
  status?: CapabilityStatus
  evidence?: EvidenceLevel
  checks?: CapabilityCheck[]
  detail?: string | null
}

/** Fields a fixture may replace on the document. */
interface DocumentOverrides {
  state?: BaselineState
  capabilities?: Record<string, CapabilityEntry>
  approval?: BaselineDocument['approval'] | null
}

/**
 * Build one successful round-trip record.
 * @returns Check record that a measured entry needs.
 */
function check(): CapabilityCheck {
  return { name: 'round-trip', at: '2026-11-17T21:00:10.000Z', expected: 'ok', observed: 'ok', ok: true }
}

/**
 * Build one capability verdict at its code level.
 * @param id Capability id.
 * @param overrides Verdict fields to replace.
 * @returns Entry record.
 */
function entry(id: CapabilityId, overrides: EntryOverrides = {}): CapabilityEntry {
  return {
    level: overrides.level ?? CAPABILITY_SPECS[id].level,
    status: overrides.status ?? 'supported',
    evidence: overrides.evidence ?? 'measured',
    checks: overrides.checks ?? [check()],
    detail: overrides.detail ?? null,
  }
}

/**
 * Build the verdict table of a fully healthy machine: every capability at its
 * code level, measured and supported.
 * @returns Capability entries keyed by id.
 */
function healthyCapabilities(): Record<string, CapabilityEntry> {
  const capabilities: Record<string, CapabilityEntry> = {}
  for (const id of CAPABILITY_IDS) capabilities[id] = entry(id)
  return capabilities
}

/**
 * Build one baseline document from a healthy default plus explicit overrides.
 * @param overrides Fields to replace.
 * @returns Document that {@link readBaseline} accepts by default.
 */
function baselineDocument(overrides: DocumentOverrides = {}): BaselineDocument {
  return {
    schema: BASELINE_SCHEMA,
    state: overrides.state ?? 'usable',
    tool: { name: 'hyprscope', version: '0.2.0' },
    probe: {
      id: 'probe-1', mode: 'full', script: 'compat-test-1',
      startedAt: '2026-11-17T21:00:00.000Z', finishedAt: '2026-11-17T21:00:30.000Z', durationMs: 30_000,
    },
    fingerprint: emptyFingerprint(),
    capabilities: overrides.capabilities ?? healthyCapabilities(),
    evidence: null,
    approval: overrides.approval === undefined
      ? { approvedAt: APPROVED_AT, approvedBy: 'human', source: 'cli', evidenceSha256: null }
      : overrides.approval,
    notes: ['fixture'],
  }
}

/**
 * Create an isolated XDG_STATE_HOME for one test.
 * @param t Test context that removes the directory afterwards.
 * @returns Absolute directory path.
 */
function newStateHome(t: TestContext): string {
  const home = mkdtempSync(join(tmpdir(), 'hyprscope-baseline-'))
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
  return home
}

/**
 * Write the approved baseline file into a fixture state home.
 * @param home XDG_STATE_HOME of the fixture.
 * @param content Document, or a raw string for malformed-file cases.
 */
function writeBaseline(home: string, content: unknown): void {
  mkdirSync(join(home, 'hyprscope'), { recursive: true })
  writeFileSync(
    join(home, 'hyprscope', 'baseline.json'),
    typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
  )
}

/**
 * Unwrap a read result that is expected to carry an accepted baseline.
 * @param result Reader result.
 * @returns The loaded baseline, assertions having passed.
 */
function loadedOf(result: Awaited<ReturnType<typeof readBaseline>>): NonNullable<typeof result.loaded> {
  if (result.loaded === null) assert.fail(result.reason ?? 'expected an accepted baseline')
  return result.loaded
}

test('every capability named by the predicate, op, and restore catalogs is declared by code', () => {
  for (const [kind, spec] of Object.entries(PREDICATE_SPECS)) {
    for (const id of spec.requires) {
      assert.ok(isCapabilityId(id), `predicate "${kind}" requires unknown capability "${id}"`)
      assert.ok(Object.hasOwn(CAPABILITY_SPECS, id), `predicate "${kind}" requires undeclared capability "${id}"`)
    }
  }
  for (const [op, spec] of Object.entries(OP_SPECS)) {
    for (const id of spec.requires) {
      assert.ok(isCapabilityId(id), `op "${op}" requires unknown capability "${id}"`)
      assert.ok(Object.hasOwn(CAPABILITY_SPECS, id), `op "${op}" requires undeclared capability "${id}"`)
    }
  }
  for (const [template, ids] of Object.entries(RESTORE_CAPABILITIES)) {
    for (const id of ids) {
      assert.ok(isCapabilityId(id), `restore template "${template}" requires unknown capability "${id}"`)
      assert.ok(Object.hasOwn(CAPABILITY_SPECS, id), `restore template "${template}" requires undeclared capability "${id}"`)
    }
  }
})

test('the catalog marks exactly seven required capabilities and one degraded one', () => {
  const required = CAPABILITY_IDS.filter(id => CAPABILITY_SPECS[id].level === 'required')
  assert.deepEqual([...required].sort(), [
    'dispatch.lua', 'events.socket', 'inject.keyboard', 'inject.pointer',
    'observe.cursor', 'observe.geometry', 'observe.hyprctl',
  ])
  const degraded = CAPABILITY_IDS.filter(id => CAPABILITY_SPECS[id].level === 'degraded')
  assert.deepEqual([...degraded], ['safety.failsafe-bind'])
  // Every other id is optional; there is no fourth level.
  const optional = CAPABILITY_IDS.filter(id => CAPABILITY_SPECS[id].level === 'optional')
  assert.equal(required.length + degraded.length + optional.length, CAPABILITY_IDS.length)
})

test('restore templates declare their capabilities, and geometry needs both halves', () => {
  for (const [kind, spec] of Object.entries(PREDICATE_SPECS)) {
    if (spec.restore === null) {
      assert.equal(spec.restorable, false, `predicate "${kind}" names no template, so it cannot be restorable`)
      continue
    }
    assert.equal(spec.restorable, true, `predicate "${kind}" names a template, so it must be restorable`)
    const template = RESTORE_CAPABILITIES[spec.restore]
    assert.ok(template.length > 0, `restore template "${spec.restore}" names no capability`)
    for (const id of template) {
      assert.ok(
        spec.requires.includes(id),
        `predicate "${kind}" uses restore template "${spec.restore}" but does not declare capability "${id}"`,
      )
    }
  }
  // Geometry recovery is all-or-nothing: a move-only or resize-only baseline
  // must never look like a usable geometry restore.
  assert.deepEqual([...RESTORE_CAPABILITIES.geometry], ['dispatch.window.move', 'dispatch.window.resize'])
  for (const id of RESTORE_CAPABILITIES.geometry) {
    assert.ok(PREDICATE_SPECS['window.geometry'].requires.includes(id), `window.geometry must require "${id}"`)
  }
  assert.deepEqual([...OP_SPECS.moveWindow.requires], ['dispatch.window.move'])
  assert.deepEqual([...OP_SPECS.resizeWindow.requires], ['dispatch.window.resize'])
})

test('a missing baseline file reads as no accepted baseline', async (t) => {
  const home = newStateHome(t)
  const result = await readBaseline({ XDG_STATE_HOME: home })
  assert.equal(result.loaded, null)
  assert.equal(result.reason, 'no accepted baseline exists on this machine')
  assert.match(result.reason ?? '', /no accepted baseline/)
  assert.deepEqual(result.warnings, [])
  assert.equal(result.path, join(home, 'hyprscope', 'baseline.json'))
})

test('a draft baseline reads as no baseline because no human accepted it', async (t) => {
  const home = newStateHome(t)
  writeBaseline(home, baselineDocument({ approval: null }))
  const result = await readBaseline({ XDG_STATE_HOME: home })
  assert.equal(result.loaded, null)
  assert.match(result.reason ?? '', /only a draft/)
  assert.match(result.reason ?? '', /human has not accepted/)
})

test('a newer schema is refused with a warning instead of guessed at', async (t) => {
  const home = newStateHome(t)
  writeBaseline(home, { ...baselineDocument(), schema: 2 })
  const result = await readBaseline({ XDG_STATE_HOME: home })
  assert.equal(result.loaded, null)
  assert.equal(result.reason, 'the baseline schema 2 is newer than this tool supports')
  assert.deepEqual(result.warnings, ['the baseline schema 2 is newer than this tool supports'])
})

test('a file that is not JSON reads as no baseline', async (t) => {
  const home = newStateHome(t)
  writeBaseline(home, '{"schema": 1, "capabilities":')
  const result = await readBaseline({ XDG_STATE_HOME: home })
  assert.equal(result.loaded, null)
  assert.equal(result.reason, 'the baseline file is not JSON')
  assert.deepEqual(result.warnings, [])
})

test('a capability id the code does not know is warned about and ignored', async (t) => {
  const home = newStateHome(t)
  const capabilities = healthyCapabilities()
  capabilities['dispatch.window.teleport'] = entry('dispatch.window.move')
  writeBaseline(home, baselineDocument({ capabilities }))
  const result = await readBaseline({ XDG_STATE_HOME: home })
  const loaded = loadedOf(result)
  assert.deepEqual(result.warnings, [
    'the baseline names capability "dispatch.window.teleport", which this version does not know; it is ignored',
  ])
  assert.equal(Object.hasOwn(loaded.document.capabilities, 'dispatch.window.teleport'), false)
  // The rest of the table still loads normally.
  assert.ok(loaded.effective.has('dispatch.window.move'))
  assert.equal(loaded.state, 'usable')
})

test('a level that disagrees with the catalog warns and the code level wins', async (t) => {
  const home = newStateHome(t)
  const capabilities = healthyCapabilities()
  capabilities['dispatch.focus.window'] = entry('dispatch.focus.window', { level: 'required' })
  writeBaseline(home, baselineDocument({ capabilities }))
  const result = await readBaseline({ XDG_STATE_HOME: home })
  const loaded = loadedOf(result)
  assert.deepEqual(result.warnings, [
    'capability "dispatch.focus.window" says level "required" but the code says "optional"; the code wins',
  ])
  assert.equal(loaded.document.capabilities['dispatch.focus.window']?.level, 'optional')
  assert.ok(loaded.effective.has('dispatch.focus.window'))
  assert.equal(loaded.state, 'usable')
})

test('supported with unknown evidence is treated as unknown', async (t) => {
  const home = newStateHome(t)
  const capabilities = healthyCapabilities()
  capabilities['dispatch.window.move'] = entry('dispatch.window.move', { evidence: 'unknown' })
  writeBaseline(home, baselineDocument({ capabilities }))
  const loaded = loadedOf(await readBaseline({ XDG_STATE_HOME: home }))
  assert.equal(loaded.effective.has('dispatch.window.move'), false)
  assert.equal(loaded.document.capabilities['dispatch.window.move']?.evidence, 'unknown')
  // An optional capability that is merely unknown only narrows itself.
  assert.equal(loaded.state, 'usable')
})

test('a required capability with advertised evidence is not effective', async (t) => {
  const home = newStateHome(t)
  const capabilities = healthyCapabilities()
  capabilities['observe.cursor'] = entry('observe.cursor', { evidence: 'advertised' })
  writeBaseline(home, baselineDocument({ state: 'incomplete', capabilities }))
  const loaded = loadedOf(await readBaseline({ XDG_STATE_HOME: home }))
  assert.equal(loaded.effective.has('observe.cursor'), false)
  assert.equal(loaded.effective.has('observe.hyprctl'), true)
  assert.equal(loaded.state, 'incomplete')
  assert.ok(loaded.warnings.includes('required capability "observe.cursor" is not measured as supported'))
})

test('an optional capability with advertised evidence stays effective', async (t) => {
  const home = newStateHome(t)
  const capabilities = healthyCapabilities()
  capabilities['capture.grim'] = entry('capture.grim', { evidence: 'advertised' })
  writeBaseline(home, baselineDocument({ capabilities }))
  const loaded = loadedOf(await readBaseline({ XDG_STATE_HOME: home }))
  assert.ok(loaded.effective.has('capture.grim'))
  assert.equal(loaded.state, 'usable')
})

test('a complete accepted document is usable and carries its approval time', async (t) => {
  const home = newStateHome(t)
  writeBaseline(home, baselineDocument())
  const result = await readBaseline({ XDG_STATE_HOME: home })
  const loaded = loadedOf(result)
  assert.equal(result.reason, null)
  assert.equal(loaded.state, 'usable')
  assert.equal(loaded.approvedAt, APPROVED_AT)
  assert.deepEqual(result.warnings, [])
  assert.equal(loaded.effective.size, CAPABILITY_IDS.length)
})

test('a baseline without the degraded failsafe capability is degraded, not incomplete', async (t) => {
  const home = newStateHome(t)
  const capabilities = healthyCapabilities()
  delete capabilities['safety.failsafe-bind']
  writeBaseline(home, baselineDocument({ state: 'degraded', capabilities }))
  const loaded = loadedOf(await readBaseline({ XDG_STATE_HOME: home }))
  assert.equal(loaded.state, 'degraded')
  assert.equal(loaded.effective.has('safety.failsafe-bind'), false)
  assert.equal(loaded.document.capabilities['safety.failsafe-bind'], undefined)
  // Only required capabilities produce a reader warning; degradation is state.
  assert.deepEqual(loaded.warnings, [])
})

test('a baseline missing a required capability is incomplete and names it', async (t) => {
  const home = newStateHome(t)
  const capabilities = healthyCapabilities()
  delete capabilities['events.socket']
  writeBaseline(home, baselineDocument({ state: 'incomplete', capabilities }))
  const loaded = loadedOf(await readBaseline({ XDG_STATE_HOME: home }))
  assert.equal(loaded.state, 'incomplete')
  assert.equal(loaded.effective.has('events.socket'), false)
  assert.deepEqual(loaded.warnings, ['required capability "events.socket" is not measured as supported'])
  const issues = missingRequiredIssues(loaded)
  assert.deepEqual(issues.map(issue => issue.capability), ['events.socket'])
  assert.equal(issues[0]?.level, 'required')
  assert.match(issues[0]?.message ?? '', /"events\.socket" is not measured as supported/)
})

test('a state field that disagrees with the entries loses to the recomputation', async (t) => {
  const home = newStateHome(t)
  writeBaseline(home, baselineDocument({ state: 'incomplete' }))
  const loaded = loadedOf(await readBaseline({ XDG_STATE_HOME: home }))
  assert.equal(loaded.state, 'usable')
  assert.equal(loaded.document.state, 'usable')
  assert.deepEqual(loaded.warnings, [
    'the file says state "incomplete" but the entries recompute to "usable"; the recomputed state wins',
  ])
})

test('a capability absent from the file counts as unknown and is not effective', async (t) => {
  const home = newStateHome(t)
  const capabilities = healthyCapabilities()
  delete capabilities['dispatch.window.resize']
  writeBaseline(home, baselineDocument({ capabilities }))
  const loaded = loadedOf(await readBaseline({ XDG_STATE_HOME: home }))
  assert.equal(loaded.document.capabilities['dispatch.window.resize'], undefined)
  assert.equal(loaded.effective.has('dispatch.window.resize'), false)
  // The other half of the geometry restore template stays effective; refusing
  // the template as a whole is the recovery layer's job, not the reader's.
  assert.ok(loaded.effective.has('dispatch.window.move'))
  assert.equal(loaded.state, 'usable')
})
