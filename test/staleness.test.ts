/** Drift detection against the live compositor: comparison rules and measurement. */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { compareEffective, measureEffective, type EffectiveState } from '../src/compat/staleness.ts'
import type { Fingerprint } from '../src/compat/types.ts'
import type { Session } from '../src/types.ts'

const MEASURED_AT = '2026-11-18T00:00:00.000Z'
const APPROVED_AT = '2026-11-17T22:00:00.000Z'
const HASH = 'sha256:0123456789abcdef'

/** One discovered session; the fake `hyprctl` ignores these values. */
const SESSION: Pick<Session, 'runtimeDir' | 'signature'> = {
  runtimeDir: '/run/user/1000',
  signature: 'test-signature',
}

/**
 * Build a fingerprint that matches {@link observedState} by default.
 * @returns Healthy recorded fingerprint.
 */
function fingerprint(): Fingerprint {
  return {
    compositor: {
      name: 'hyprland',
      version: '0.50.1',
      branch: 'main',
      commit: 'abc123',
      configProvider: 'hyprlang',
      backend: 'wayland',
    },
    monitors: [],
    seats: { count: 1, name: 1 },
    waylandGlobals: [],
    config: {
      dir: '/home/user/.config/hypr',
      luaFile: null,
      failsafeKey: 'SUPER + ALT + ESC',
      failsafeBound: true,
    },
    helpers: { inject: true, scratch: true },
    effective: {
      configProvider: 'hyprlang',
      followMouse: '1',
      binds: { count: 2, plainF12: true },
      configErrors: [],
    },
    configHash: null,
  }
}

/** Fields a test may replace on the recorded effective record. */
type EffectiveOverrides = Partial<NonNullable<Fingerprint['effective']>>

/**
 * Build a complete effective record with explicit overrides.
 * @param overrides Fields to replace.
 * @returns Effective record.
 */
function effective(overrides: EffectiveOverrides = {}): NonNullable<Fingerprint['effective']> {
  return {
    configProvider: 'hyprlang',
    followMouse: '1',
    binds: { count: 2, plainF12: true },
    configErrors: [],
    ...overrides,
  }
}

/** Fields a test may replace on the recorded fingerprint. */
interface RecordedOverrides {
  version?: string | null
  compositorProvider?: string | null
  effective?: Fingerprint['effective']
  configHash?: string | null
}

/**
 * Build a recorded fingerprint with explicit overrides.
 * @param overrides Fields to replace.
 * @returns Fingerprint, with an effective record unless overridden.
 */
function recorded(overrides: RecordedOverrides = {}): Fingerprint {
  const base = fingerprint()
  return {
    ...base,
    compositor: {
      ...base.compositor,
      version: overrides.version === undefined ? base.compositor.version : overrides.version,
      configProvider: overrides.compositorProvider === undefined
        ? base.compositor.configProvider
        : overrides.compositorProvider,
    },
    effective: overrides.effective === undefined ? base.effective : overrides.effective,
    configHash: overrides.configHash === undefined ? base.configHash : overrides.configHash,
  }
}

/**
 * Build the live effective state that matches {@link fingerprint} by default.
 * @param overrides Fields to replace.
 * @returns Observed state.
 */
function observedState(overrides: Partial<EffectiveState> = {}): EffectiveState {
  return {
    version: '0.50.1',
    configProvider: 'hyprlang',
    followMouse: '1',
    bindCount: 2,
    plainF12: true,
    configErrors: [],
    ...overrides,
  }
}

/** Default JSON the fake `hyprctl` prints for each read-only command. */
const FAKE_OUTPUT: Record<string, string> = {
  version: '{"version":"0.50.1"}',
  status: '{"configProvider":"hyprlang"}',
  getoption: '{"option":"input:follow_mouse","int":1,"set":true}',
  binds: '[{"modmask":0,"key":"F12"},{"modmask":64,"key":"Q"}]',
  configerrors: '[]',
}

/** Options for {@link fakeHyprctl}. */
interface FakeHyprctlOptions {
  /** Per-command JSON output, replacing the defaults. */
  outputs?: Record<string, string>
  /** Commands that exit 1 instead of printing. */
  fail?: string[]
  /** When true, every invocation exits 1 without output. */
  failAll?: boolean
}

/**
 * Temporary root: `TMPDIR` when the harness sets one, the OS default otherwise.
 * @returns Existing directory path.
 */
function tempBase(): string {
  const base = process.env.TMPDIR ?? tmpdir()
  mkdirSync(base, { recursive: true })
  return base
}

/**
 * Write an executable fake `hyprctl` into a fresh temporary directory.
 * @param t Test context that removes the directory afterwards.
 * @param options Per-command output and failures.
 * @returns Absolute path to the fake binary.
 */
function fakeHyprctl(t: TestContext, options: FakeHyprctlOptions = {}): string {
  const directory = mkdtempSync(join(tempBase(), 'hyprscope-staleness-'))
  t.after(() => { rmSync(directory, { recursive: true, force: true }) })
  const script = join(directory, 'hyprctl')
  if (options.failAll === true) {
    writeFileSync(script, '#!/bin/sh\nexit 1\n')
    chmodSync(script, 0o755)
    return script
  }
  const outputs = { ...FAKE_OUTPUT, ...options.outputs }
  const lines = ['#!/bin/sh', 'if [ "$1" = "-j" ]; then shift; fi', 'case "$1" in']
  for (const [command, output] of Object.entries(outputs)) {
    if (options.fail?.includes(command) === true) lines.push('  ' + command + ') exit 1 ;;')
    else lines.push("  " + command + ") printf '%s' '" + output + "' ;;")
  }
  lines.push("  *) printf '%s' '{}' ;;", 'esac', '')
  writeFileSync(script, lines.join('\n'))
  chmodSync(script, 0o755)
  return script
}

/**
 * Make a fake binary the one `hyprctlJson` runs.
 * @param t Test context that restores the previous value afterwards.
 * @param script Absolute path to the fake binary.
 */
function useBinary(t: TestContext, script: string): void {
  const previous = process.env.HYPRSCOPE_HYRPRCTL
  process.env.HYPRSCOPE_HYRPRCTL = script
  t.after(() => {
    if (previous === undefined) delete process.env.HYPRSCOPE_HYRPRCTL
    else process.env.HYPRSCOPE_HYRPRCTL = previous
  })
}

test('a matching fingerprint is fresh and records the measurement time', () => {
  const report = compareEffective(recorded(), observedState(), { measuredAt: MEASURED_AT })
  assert.deepEqual(report, {
    verdict: 'fresh',
    reasons: [],
    differences: [],
    measuredAt: MEASURED_AT,
    recorded: true,
  })
})

test('measuredAt falls back to the injected clock', () => {
  const report = compareEffective(recorded(), observedState(), {
    now: () => new Date('2026-11-18T01:02:03.000Z'),
  })
  assert.equal(report.measuredAt, '2026-11-18T01:02:03.000Z')
})

test('a changed compositor version is stale', () => {
  const report = compareEffective(recorded(), observedState({ version: '0.51.0' }), { measuredAt: MEASURED_AT })
  assert.equal(report.verdict, 'stale')
  assert.equal(report.recorded, true)
  assert.deepEqual(report.differences, [{ field: 'version', recorded: '0.50.1', observed: '0.51.0' }])
  assert.equal(report.reasons.length, 1)
  assert.match(report.reasons[0] ?? '', /compositor version changed/)
})

test('a changed configuration provider is stale', () => {
  const report = compareEffective(recorded(), observedState({ configProvider: 'lua' }), { measuredAt: MEASURED_AT })
  assert.equal(report.verdict, 'stale')
  assert.deepEqual(report.differences, [{ field: 'configProvider', recorded: 'hyprlang', observed: 'lua' }])
  assert.match(report.reasons[0] ?? '', /configuration provider changed/)
})

test('a changed follow_mouse value is stale', () => {
  const report = compareEffective(recorded(), observedState({ followMouse: '2' }), { measuredAt: MEASURED_AT })
  assert.equal(report.verdict, 'stale')
  assert.deepEqual(report.differences, [{ field: 'followMouse', recorded: '1', observed: '2' }])
  assert.match(report.reasons[0] ?? '', /follow_mouse value changed/)
})

test('a changed bind count is stale and stringifies the numbers', () => {
  const report = compareEffective(recorded(), observedState({ bindCount: 3 }), { measuredAt: MEASURED_AT })
  assert.equal(report.verdict, 'stale')
  assert.deepEqual(report.differences, [{ field: 'binds.count', recorded: '2', observed: '3' }])
  assert.match(report.reasons[0] ?? '', /bind count changed/)
})

test('a changed plain F12 binding is stale and stringifies the booleans', () => {
  const report = compareEffective(recorded(), observedState({ plainF12: false }), { measuredAt: MEASURED_AT })
  assert.equal(report.verdict, 'stale')
  assert.deepEqual(report.differences, [{ field: 'binds.plainF12', recorded: 'true', observed: 'false' }])
  assert.match(report.reasons[0] ?? '', /F12 is bound without modifiers changed/)
})

test('configuration errors compare as a set, not by order', () => {
  const fp = recorded({ effective: effective({ configErrors: ['b', 'a'] }) })
  const reordered = compareEffective(fp, observedState({ configErrors: ['a', 'b'] }), { measuredAt: MEASURED_AT })
  assert.equal(reordered.verdict, 'fresh')
  assert.deepEqual(reordered.differences, [])

  const changed = compareEffective(fp, observedState({ configErrors: ['a', 'c'] }), { measuredAt: MEASURED_AT })
  assert.equal(changed.verdict, 'stale')
  assert.deepEqual(changed.differences, [{ field: 'configErrors', recorded: 'a | b', observed: 'a | c' }])
  assert.match(changed.reasons[0] ?? '', /configuration errors changed/)
})

test('a changed config hash is stale and an equal one is fresh', () => {
  const fp = recorded({ configHash: HASH })
  assert.equal(compareEffective(fp, observedState(), { configHash: HASH }).verdict, 'fresh')

  const report = compareEffective(fp, observedState(), {
    configHash: 'sha256:ffff',
    measuredAt: MEASURED_AT,
  })
  assert.equal(report.verdict, 'stale')
  assert.deepEqual(report.differences, [{ field: 'configHash', recorded: HASH, observed: 'sha256:ffff' }])
  assert.match(report.reasons[0] ?? '', /configuration hash changed/)
})

test('a recorded config hash with no observed hash is stale', () => {
  const fp = recorded({ configHash: HASH })
  const omitted = compareEffective(fp, observedState(), { measuredAt: MEASURED_AT })
  assert.equal(omitted.verdict, 'stale')
  assert.deepEqual(omitted.differences, [])
  assert.equal(omitted.reasons.length, 1)
  assert.match(omitted.reasons[0] ?? '', /hash is unavailable/)

  const explicitNull = compareEffective(fp, observedState(), { configHash: null })
  assert.equal(explicitNull.verdict, 'stale')
})

test('a recorded null config hash skips the hash comparison', () => {
  const report = compareEffective(recorded(), observedState(), {
    configHash: 'sha256:ffff',
    measuredAt: MEASURED_AT,
  })
  assert.equal(report.verdict, 'fresh')
  assert.deepEqual(report.differences, [])
})

test('a fingerprint without effective configuration is unverified and must be re-probed', () => {
  const report = compareEffective(recorded({ effective: null }), observedState({ version: '9.9.9' }), {
    measuredAt: MEASURED_AT,
  })
  assert.equal(report.verdict, 'unverified')
  assert.equal(report.recorded, false)
  assert.deepEqual(report.differences, [])
  assert.equal(report.reasons.length, 1)
  assert.match(report.reasons[0] ?? '', /does not record effective configuration/)
  assert.match(report.reasons[0] ?? '', /re-probed/)
})

test('a recorded null field leaves the report unverified, not stale', () => {
  const scenarios: { name: string; fingerprint: Fingerprint; pattern: RegExp }[] = [
    { name: 'version', fingerprint: recorded({ version: null }), pattern: /compositor version/ },
    {
      name: 'provider',
      fingerprint: recorded({ compositorProvider: null, effective: effective({ configProvider: null }) }),
      pattern: /configuration provider/,
    },
    {
      name: 'follow_mouse',
      fingerprint: recorded({ effective: effective({ followMouse: null }) }),
      pattern: /input:follow_mouse/,
    },
    {
      name: 'binds',
      fingerprint: recorded({ effective: effective({ binds: null }) }),
      pattern: /bind summary/,
    },
    {
      name: 'config errors',
      fingerprint: recorded({ effective: effective({ configErrors: null }) }),
      pattern: /configuration errors/,
    },
  ]
  for (const scenario of scenarios) {
    const report = compareEffective(scenario.fingerprint, observedState(), { measuredAt: MEASURED_AT })
    assert.equal(report.verdict, 'unverified', scenario.name)
    assert.equal(report.recorded, true, scenario.name)
    assert.deepEqual(report.differences, [], scenario.name)
    assert.equal(report.reasons.length, 1, scenario.name)
    assert.match(report.reasons[0] ?? '', scenario.pattern, scenario.name)
  }
})

test('the compositor provider stands in when the effective record omits it', () => {
  const fp = recorded({ effective: effective({ configProvider: null }) })
  const report = compareEffective(fp, observedState(), { measuredAt: MEASURED_AT })
  assert.equal(report.verdict, 'fresh')
})

test('an observed null field is stale because the running instance cannot be attested', () => {
  const scenarios: { name: string; state: EffectiveState; pattern: RegExp }[] = [
    { name: 'version', state: observedState({ version: null }), pattern: /compositor version/ },
    { name: 'provider', state: observedState({ configProvider: null }), pattern: /configuration provider/ },
    { name: 'follow_mouse', state: observedState({ followMouse: null }), pattern: /input:follow_mouse/ },
    { name: 'bind count', state: observedState({ bindCount: null }), pattern: /bind count/ },
    { name: 'plain F12', state: observedState({ plainF12: null }), pattern: /F12/ },
    { name: 'config errors', state: observedState({ configErrors: null }), pattern: /configuration errors/ },
  ]
  for (const scenario of scenarios) {
    const report = compareEffective(recorded(), scenario.state, { measuredAt: MEASURED_AT })
    assert.equal(report.verdict, 'stale', scenario.name)
    assert.deepEqual(report.differences, [], scenario.name)
    assert.equal(report.reasons.length, 1, scenario.name)
    assert.match(report.reasons[0] ?? '', scenario.pattern, scenario.name)
  }
})

test('differences sort by field and reasons follow comparison order', () => {
  const fp = recorded({
    effective: effective({
      configProvider: 'hyprlang',
      followMouse: '1',
      binds: { count: 2, plainF12: true },
      configErrors: ['b'],
    }),
    configHash: HASH,
  })
  const live = observedState({
    version: '0.51.0',
    configProvider: 'lua',
    followMouse: '2',
    bindCount: 3,
    plainF12: false,
    configErrors: ['a'],
  })
  const options = { configHash: 'sha256:other', measuredAt: MEASURED_AT, approvedAt: APPROVED_AT }
  const first = compareEffective(fp, live, options)
  const second = compareEffective(fp, live, options)
  assert.deepEqual(first, second)
  assert.equal(first.verdict, 'stale')
  assert.deepEqual(first.differences.map(difference => difference.field), [
    'binds.count',
    'binds.plainF12',
    'configErrors',
    'configHash',
    'configProvider',
    'followMouse',
    'version',
  ])
  assert.equal(first.reasons.length, 8)
  assert.match(first.reasons[0] ?? '', /^The compositor version changed/)
  assert.match(first.reasons[1] ?? '', /^The configuration provider changed/)
  assert.match(first.reasons[2] ?? '', /^The effective input:follow_mouse value changed/)
  assert.match(first.reasons[3] ?? '', /^The bind count changed/)
  assert.match(first.reasons[4] ?? '', /^Whether F12 is bound without modifiers changed/)
  assert.match(first.reasons[5] ?? '', /^The configuration errors changed/)
  assert.match(first.reasons[6] ?? '', /^The configuration hash changed/)
  assert.ok(first.reasons[7]?.includes('accepted at ' + APPROVED_AT))
})

test('approvedAt appears only in a stale verdict', () => {
  const fresh = compareEffective(recorded(), observedState(), { measuredAt: MEASURED_AT, approvedAt: APPROVED_AT })
  assert.equal(fresh.verdict, 'fresh')
  assert.deepEqual(fresh.reasons, [])

  const unverified = compareEffective(recorded({ effective: null }), observedState(), { approvedAt: APPROVED_AT })
  assert.equal(unverified.reasons.length, 1)
  assert.equal(unverified.reasons[0]?.includes('accepted at') ?? false, false)
})

test('measureEffective reads version, provider, follow_mouse, binds, and config errors', async (t) => {
  const script = fakeHyprctl(t)
  useBinary(t, script)
  const state = await measureEffective(SESSION)
  assert.deepEqual(state, {
    version: '0.50.1',
    configProvider: 'hyprlang',
    followMouse: '1',
    bindCount: 2,
    plainF12: true,
    configErrors: [],
  })
})

test('measureEffective accepts custom and str option values when int is absent', async (t) => {
  const custom = fakeHyprctl(t, { outputs: { getoption: '{"custom":"2"}' } })
  useBinary(t, custom)
  assert.equal((await measureEffective(SESSION)).followMouse, '2')

  const str = fakeHyprctl(t, { outputs: { getoption: '{"str":"0"}' } })
  process.env.HYPRSCOPE_HYRPRCTL = str
  assert.equal((await measureEffective(SESSION)).followMouse, '0')
})

test('an empty binds array is measured as zero binds and no plain F12', async (t) => {
  const script = fakeHyprctl(t, { outputs: { binds: '[]', configerrors: '["bad config"]' } })
  useBinary(t, script)
  const state = await measureEffective(SESSION)
  assert.equal(state.bindCount, 0)
  assert.equal(state.plainF12, false)
  assert.deepEqual(state.configErrors, ['bad config'])
})

test('measureEffective normalizes the compositor [""] no-errors shape to an empty list', async (t) => {
  const script = fakeHyprctl(t, { outputs: { configerrors: '[""]' } })
  useBinary(t, script)
  const state = await measureEffective(SESSION)
  assert.deepEqual(state.configErrors, [])
})

test('config errors normalize trimming and the [""] no-errors shape on both sides', () => {
  const emptyRecorded = compareEffective(
    recorded({ effective: effective({ configErrors: [''] }) }),
    observedState({ configErrors: [] }),
    { measuredAt: MEASURED_AT },
  )
  assert.equal(emptyRecorded.verdict, 'fresh')
  assert.deepEqual(emptyRecorded.differences, [])

  const emptyObserved = compareEffective(
    recorded({ effective: effective({ configErrors: [] }) }),
    observedState({ configErrors: [''] }),
    { measuredAt: MEASURED_AT },
  )
  assert.equal(emptyObserved.verdict, 'fresh')

  const padded = compareEffective(
    recorded({ effective: effective({ configErrors: ['  bad option  ', ''] }) }),
    observedState({ configErrors: ['bad option'] }),
    { measuredAt: MEASURED_AT },
  )
  assert.equal(padded.verdict, 'fresh')
})

test('a failed binds query leaves only the bind fields null', async (t) => {
  const script = fakeHyprctl(t, { fail: ['binds'] })
  useBinary(t, script)
  const state = await measureEffective(SESSION, { timeoutMs: 1000 })
  assert.deepEqual(state, {
    version: '0.50.1',
    configProvider: 'hyprlang',
    followMouse: '1',
    bindCount: null,
    plainF12: null,
    configErrors: [],
  })
})

test('measureEffective resolves with all nulls when every query fails', async (t) => {
  const script = fakeHyprctl(t, { failAll: true })
  useBinary(t, script)
  const state = await measureEffective(SESSION)
  assert.deepEqual(state, {
    version: null,
    configProvider: null,
    followMouse: null,
    bindCount: null,
    plainF12: null,
    configErrors: null,
  })
})
