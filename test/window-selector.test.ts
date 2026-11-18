/** Window-selector resolution: zero, one and ambiguous matches, with candidate lines. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseArgs, renderWindowCandidates, resolveWindowIdentifier, windowCandidates } from '../src/cli.ts'
import type { Toplevel } from '../src/toplevel.ts'
import type { RawClient, RawWorkspace } from '../src/types.ts'
import { fakeSession, removeDir, tempDir, writeScript } from './support.ts'

/** Fake compositor binaries for one fixture directory. */
interface Fixture {
  hyprctl: string
  capture: string
}

/** Test context subset used to restore the environment. */
interface Cleanup {
  after(callback: () => void): void
}

/**
 * Build a fake hyprctl and wl-capture that answer clients, activeworkspace and --list.
 * @param directory Fixture directory.
 * @param toplevels Foreign toplevels the capture helper lists.
 * @param clients Client records hyprctl reports.
 * @param activeWorkspace Active workspace record.
 * @returns Script paths.
 */
function fakeCompositor(
  directory: string, toplevels: Toplevel[], clients: RawClient[], activeWorkspace: RawWorkspace,
): Fixture {
  const toplevelsFile = join(directory, 'toplevels.json')
  writeFileSync(toplevelsFile, JSON.stringify({ ok: true, toplevels }))
  const clientsFile = join(directory, 'clients.json')
  writeFileSync(clientsFile, JSON.stringify(clients))
  const activeFile = join(directory, 'activeworkspace.json')
  writeFileSync(activeFile, JSON.stringify(activeWorkspace))
  const hyprctl = writeScript(directory, 'hyprctl', [
    '#!/bin/sh',
    'case "$2" in',
    `  clients) cat "${clientsFile}" ;;`,
    `  activeworkspace) cat "${activeFile}" ;;`,
    '  *) echo "{}" ;;',
    'esac',
    '',
  ].join('\n'))
  const capture = writeScript(directory, 'wl-capture', [
    '#!/bin/sh',
    `cat "${toplevelsFile}"`,
    '',
  ].join('\n'))
  return { hyprctl, capture }
}

/**
 * Point hyprctl and the capture helper at a fixture for one test.
 * @param t Test context.
 * @param fixture Fixture scripts.
 */
function useFixture(t: Cleanup, fixture: Fixture): void {
  const previous = { hyprctl: process.env.HYPRSCOPE_HYRPRCTL, capture: process.env.HYPRSCOPE_CAPTURE }
  process.env.HYPRSCOPE_HYRPRCTL = fixture.hyprctl
  process.env.HYPRSCOPE_CAPTURE = fixture.capture
  t.after(() => {
    if (previous.hyprctl === undefined) delete process.env.HYPRSCOPE_HYRPRCTL
    else process.env.HYPRSCOPE_HYRPRCTL = previous.hyprctl
    if (previous.capture === undefined) delete process.env.HYPRSCOPE_CAPTURE
    else process.env.HYPRSCOPE_CAPTURE = previous.capture
  })
}

/** Two foot windows on workspaces 1 and 4, listed out of order. */
const footToplevels: Toplevel[] = [
  { identifier: '180001c6', appId: 'foot', title: 'rclone mount OneDriv ~' },
  { identifier: '180002d9', appId: 'foot', title: '~/w/dsh-hyprscope' },
]
const footClients: RawClient[] = [
  { address: '0x56035f695030', stableId: '180001c6', class: 'foot', workspace: { id: 4, name: '4' } },
  { address: '0x560360f3c380', stableId: '180002d9', class: 'foot', workspace: { id: 1, name: '1' } },
]

test('resolveWindowIdentifier reports no match without candidates', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  useFixture(t, fakeCompositor(directory,
    [{ identifier: '180001c6', appId: 'zen', title: 'browser' }], [], { id: 1 }))
  await assert.rejects(resolveWindowIdentifier(fakeSession(), parseArgs(['screenshot', '--window-app', 'foot']).options),
    (error: Error & { code?: string; details?: { available?: string[] } }) => {
      assert.equal(error.code, 'SCREENSHOT_FAILED')
      assert.match(error.message, /No window has this application id/)
      assert.deepEqual(error.details?.available, ['zen'])
      return true
    })
})

test('resolveWindowIdentifier returns the only matching toplevel', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const toplevels: Toplevel[] = [
    { identifier: '180001c6', appId: 'foot', title: 'rclone mount OneDriv ~' },
    { identifier: '180001ce', appId: 'zen', title: 'browser' },
  ]
  const clients: RawClient[] = [
    { address: '0x56035f695030', stableId: '180001c6', class: 'foot', workspace: { id: 1, name: '1' } },
    { address: '0x560360f3c380', stableId: '180001ce', class: 'zen', workspace: { id: 2, name: '2' } },
  ]
  useFixture(t, fakeCompositor(directory, toplevels, clients, { id: 1 }))
  const identifier = await resolveWindowIdentifier(fakeSession(), parseArgs(['screenshot', '--window-app', 'foot']).options)
  assert.equal(identifier, '180001c6')
  const byTitle = await resolveWindowIdentifier(fakeSession(),
    parseArgs(['screenshot', '--window-title', 'browser']).options)
  assert.equal(byTitle, '180001ce')
})

test('resolveWindowIdentifier lists ambiguous application ids in workspace then address order', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  useFixture(t, fakeCompositor(directory, footToplevels, footClients, { id: 1 }))
  await assert.rejects(resolveWindowIdentifier(fakeSession(), parseArgs(['screenshot', '--window-app', 'foot']).options),
    (error: Error & { code?: string; details?: { candidates?: unknown[]; hint?: string } }) => {
      assert.equal(error.code, 'USAGE')
      assert.equal(error.message, [
        '2 windows match this application id; use --window-id to pick one:',
        '  - 0x560360f3c380  foot  workspace 1  title "~/w/dsh-hyprscope"  on active workspace',
        '  - 0x56035f695030  foot  workspace 4  title "rclone mount OneDriv ~"  off-screen',
      ].join('\n'))
      assert.deepEqual(error.details?.candidates, [
        {
          identifier: '180002d9', address: '0x560360f3c380', appId: 'foot', workspace: 1,
          title: '~/w/dsh-hyprscope', active: true,
        },
        {
          identifier: '180001c6', address: '0x56035f695030', appId: 'foot', workspace: 4,
          title: 'rclone mount OneDriv ~', active: false,
        },
      ])
      assert.match(error.details?.hint ?? '', /--window-id/)
      return true
    })
})

test('resolveWindowIdentifier lists duplicate titles the same way', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const toplevels: Toplevel[] = [
    { identifier: '180001ce', appId: 'zen', title: 'shell' },
    { identifier: '180001c6', appId: 'foot', title: 'shell' },
  ]
  const clients: RawClient[] = [
    { address: '0xaaa', stableId: '180001ce', class: 'zen', workspace: { id: 2, name: '2' } },
    { address: '0xbbb', stableId: '180001c6', class: 'foot', workspace: { id: 2, name: '2' } },
  ]
  useFixture(t, fakeCompositor(directory, toplevels, clients, { id: 2 }))
  await assert.rejects(resolveWindowIdentifier(fakeSession(),
    parseArgs(['screenshot', '--window-title', 'shell']).options),
  (error: Error & { code?: string }) => {
    assert.equal(error.code, 'USAGE')
    assert.equal(error.message.split('\n')[0], '2 windows match this title; use --window-id to pick one:')
    // Same workspace: the address decides, deterministically.
    assert.deepEqual(error.message.split('\n').slice(1), [
      '  - 0xaaa  zen  workspace 2  title "shell"  on active workspace',
      '  - 0xbbb  foot  workspace 2  title "shell"  on active workspace',
    ])
    return true
  })
})

test('windowCandidates marks an unknown active workspace and keeps unmatched toplevels', () => {
  const candidates = windowCandidates([
    { identifier: '180002d9', appId: 'foot', title: 'second' },
    { identifier: '180001c6', appId: 'foot', title: 'first' },
    { identifier: '180001ce', appId: 'zen', title: 'unmatched' },
  ], [{ address: '0x2', stableId: '180001c6', workspace: { id: 3 } }, { address: '0x1', stableId: '180002d9', workspace: { id: 3 } }], null)
  assert.deepEqual(candidates.map(candidate => candidate.identifier), ['180002d9', '180001c6', '180001ce'])
  assert.equal(candidates[0]!.active, null)
  assert.equal(candidates[2]!.address, null)
  assert.equal(candidates[2]!.workspace, null)
})

test('renderWindowCandidates states active, off-screen and unknown workspaces', () => {
  const lines = renderWindowCandidates([
    { identifier: 'a', address: '0x1', appId: 'foot', workspace: 1, title: 'one', active: true },
    { identifier: 'b', address: '0x2', appId: 'foot', workspace: 4, title: 'two', active: false },
    { identifier: 'c', address: null, appId: 'zen', workspace: null, title: 'three', active: null },
  ])
  assert.deepEqual(lines, [
    '  - 0x1  foot  workspace 1  title "one"  on active workspace',
    '  - 0x2  foot  workspace 4  title "two"  off-screen',
    '  - c  zen  workspace unknown  title "three"  active workspace unknown',
  ])
})
