/** Argument parsing and command routing without a compositor. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { main, parseArgs } from '../src/cli.ts'
import { main as entryMain } from '../src/entry.ts'
import { sink } from './support.ts'

test('parseArgs reads flags and value options', () => {
  const parsed = parseArgs(['state', '--json', '--timeout', '250', '--signature', 'sig', '--output=shot.png'])
  assert.equal(parsed.command, 'state')
  assert.equal(parsed.options.json, true)
  assert.equal(parsed.options.timeoutMs, 250)
  assert.equal(parsed.options.signature, 'sig')
  assert.equal(parsed.options.output, 'shot.png')
})

test('parseArgs reads the desktop selector', () => {
  const parsed = parseArgs(['state', '--desktop', 'agent'])
  assert.equal(parsed.options.desktop, 'agent')
  assert.equal(parseArgs(['state']).options.desktop, undefined)
})

test('parseArgs accepts = for value options', () => {
  const parsed = parseArgs(['screenshot', '--region=1,2,3,4', '--monitor=HDMI-A-1'])
  assert.equal(parsed.options.region, '1,2,3,4')
  assert.equal(parsed.options.monitor, 'HDMI-A-1')
})

test('parseArgs reads the window capture selectors', () => {
  const parsed = parseArgs(['screenshot', '--window-app=zen', '--output=shot.png'])
  assert.equal(parsed.options.windowApp, 'zen')
  assert.equal(parsed.options.output, 'shot.png')
  assert.equal(parseArgs(['screenshot', '--window-id', '0x1234']).options.windowId, '0x1234')
  assert.equal(parseArgs(['screenshot', '--window-title=term']).options.windowTitle, 'term')
})

test('usage lists the window capture options', async () => {
  const stdout = sink()
  assert.equal(await main(['--help'], { stdout, stderr: sink() }), 0)
  assert.match(stdout.text, /--window-id/)
  assert.match(stdout.text, /--window-app/)
  assert.match(stdout.text, /--window-title/)
})

test('parseArgs rejects unknown options and bad values', () => {
  for (const argv of [['state', '--wat'], ['state', '--timeout', 'soon'], ['state', '--count', '0'],
    ['state', '--json=yes'], ['state', '--timeout']]) {
    assert.throws(() => parseArgs(argv), (error: Error & { code?: string }) => error.code === 'USAGE', JSON.stringify(argv))
  }
})

test('main prints usage and exits 0 for --help', async () => {
  const stdout = sink()
  const code = await main(['--help'], { stdout, stderr: sink() })
  assert.equal(code, 0)
  assert.match(stdout.text, /Usage: hyprscope/)
  // Agents read this help too: the feedback route has to be in it.
  assert.match(stdout.text, /github\.com\/LianyeSheng\/dsh-hyprscope\/issues/)
  assert.match(stdout.text, /doctor --json/)
})

test('main prints usage and exits 2 for no command', async () => {
  const stderr = sink()
  const code = await main([], { stdout: sink(), stderr })
  assert.equal(code, 2)
  assert.match(stderr.text, /Usage: hyprscope/)
})

test('main exits 2 for an unknown command', async () => {
  const stderr = sink()
  const code = await main(['launch-missiles'], { stdout: sink(), stderr })
  assert.equal(code, 2)
  assert.match(stderr.text, /Unknown command/)
})

test('main reports USAGE as JSON on stderr when --json is set', async () => {
  const stdout = sink()
  const stderr = sink()
  const code = await main(['nope', '--json'], { stdout, stderr })
  assert.equal(code, 2)
  const report = JSON.parse(stderr.text) as { error: { code: string } }
  assert.equal(report.error.code, 'USAGE')
})
test('entry routes control to the lease-gated surface', async () => {
  const stdout = sink()
  const code = await entryMain(['control', '--help'], { stdout, stderr: sink() })
  assert.equal(code, 0)
  assert.match(stdout.text, /Usage: hyprscope control/)
  assert.match(stdout.text, /baseline/)
})

test('entry requires a command under control', async () => {
  const stderr = sink()
  const code = await entryMain(['control'], { stdout: sink(), stderr })
  assert.equal(code, 2)
  assert.match(stderr.text, /Usage: hyprscope control/)
})

test('entry suggests the control namespace for a misplaced control command', async () => {
  const stderr = sink()
  const code = await entryMain(['run'], { stdout: sink(), stderr })
  assert.equal(code, 2)
  assert.match(stderr.text, /hyprscope control run/)
})

test('entry keeps --version on the umbrella name under control', async () => {
  const stdout = sink()
  const code = await entryMain(['control', '--version'], { stdout, stderr: sink() })
  assert.equal(code, 0)
  assert.match(stdout.text, /^hyprscope \d/)
})
