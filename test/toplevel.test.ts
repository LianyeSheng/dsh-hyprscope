/** Window capture wiring through a fake wl-capture helper, plus orientation. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { captureToplevel, listToplevels, orientImage } from '../src/toplevel.ts'
import { fakeSession, removeDir, tempDir, writeScript } from './support.ts'

const captureEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  XDG_RUNTIME_DIR: '/run/user/1000',
  WAYLAND_DISPLAY: 'wayland-1',
}

/**
 * Build a fake capture helper that answers --list and --capture.
 * @param directory Fixture directory.
 * @param failure Optional JSON failure line for capture mode.
 * @returns Script path and argument log path.
 */
function fakeCapture(directory: string, failure?: string): { script: string; args: string } {
  const args = join(directory, 'capture.args')
  const script = writeScript(directory, 'wl-capture', [
    '#!/bin/sh',
    'printf \'%s\\n\' "$@" > "' + args + '"',
    'mode=""',
    'id=""',
    'raw=""',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    --list) mode=list ;;',
    '    --capture) mode=capture; id="$2"; shift ;;',
    '    --raw) raw="$2"; shift ;;',
    '    --timeout-ms) shift ;;',
    '  esac',
    '  shift',
    'done',
    'if [ "$mode" = list ]; then',
    '  printf \'%s\\n\' \'{"ok":true,"toplevels":[{"identifier":"180001c6","appId":"foot","title":"shell"},{"identifier":"180001ce","appId":"zen","title":"browser"}]}\'',
    '  exit 0',
    'fi',
    ...(failure === undefined
      ? [
          'printf "\\377\\000\\000\\377\\000\\377\\000\\377" > "$raw"',
          'printf \'%s\\n\' \'{"ok":true,"identifier":"\'"$id"\'","appId":"foot","title":"shell","width":2,"height":1,"format":"argb8888","transform":0,"bytes":8}\'',
        ]
      : ["printf '%s\\n' '" + failure + "'", 'exit 1']),
    '',
  ].join('\n'))
  return { script, args }
}

test('listToplevels reads the foreign toplevel list', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const capture = fakeCapture(directory)
  const toplevels = await listToplevels(fakeSession(), { binary: capture.script, env: captureEnv })
  assert.deepEqual(toplevels, [
    { identifier: '180001c6', appId: 'foot', title: 'shell' },
    { identifier: '180001ce', appId: 'zen', title: 'browser' },
  ])
  assert.equal(readFileSync(capture.args, 'utf8').trim(), '--list')
})

test('captureToplevel writes a PNG and reports the window source', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const capture = fakeCapture(directory)
  const output = join(directory, 'window.png')
  const result = await captureToplevel(fakeSession(), {
    output, identifier: '180001c6', binary: capture.script, env: captureEnv,
  })
  assert.equal(result.source.scope, 'window')
  assert.deepEqual(result.source.window, { identifier: '180001c6', appId: 'foot', title: 'shell' })
  assert.equal(result.width, 2)
  assert.equal(result.height, 1)
  assert.equal(result.bytes, readFileSync(output).length)
  assert.equal(existsSync(output + '.rgba'), false)
  const argv = readFileSync(capture.args, 'utf8').trim().split('\n')
  assert.deepEqual(argv, ['--capture', '180001c6', '--raw', output + '.rgba', '--timeout-ms', '10000'])
})

test('captureToplevel reports a helper-compositor failure as SCREENSHOT_FAILED', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const capture = fakeCapture(directory, '{"ok":false,"error":"toplevel-not-found: no mapped toplevel has this identifier"}')
  await assert.rejects(captureToplevel(fakeSession(), {
    output: join(directory, 'x.png'), identifier: 'deadbeef', binary: capture.script, env: captureEnv,
  }), (error: Error & { code?: string; details?: { reason?: string } }) => {
    assert.equal(error.code, 'SCREENSHOT_FAILED')
    assert.match(error.details?.reason ?? '', /toplevel-not-found/)
    return true
  })
})

test('captureToplevel refuses an explicit output in a missing directory before running the helper', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const capture = fakeCapture(directory)
  const output = join(directory, 'missing', 'window.png')
  await assert.rejects(captureToplevel(fakeSession(), {
    output, identifier: '180001c6', binary: capture.script, env: captureEnv,
  }), (error: Error & { code?: string; message: string; details?: { directory?: string } }) => {
    assert.equal(error.code, 'SCREENSHOT_FAILED')
    assert.match(error.message, /pass --output <writable path>/)
    assert.equal(error.details?.directory, join(directory, 'missing'))
    return true
  })
  assert.equal(existsSync(join(directory, 'missing')), false, 'the preflight must not create an explicit output directory')
  assert.equal(existsSync(capture.args), false, 'the helper must not run when the destination is unusable')
})

test('captureToplevel explains a missing helper build', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  await assert.rejects(captureToplevel(fakeSession(), {
    output: join(directory, 'x.png'), identifier: '180001c6',
    binary: join(directory, 'nope', 'wl-capture'), env: captureEnv,
  }), (error: Error & { code?: string; details?: { hint?: string } }) => {
    assert.equal(error.code, 'SCREENSHOT_FAILED')
    assert.match(error.details?.hint ?? '', /build:capture/)
    return true
  })
})

test('captureToplevel refuses a screenshot without a Wayland display', async () => {
  await assert.rejects(captureToplevel(fakeSession({ waylandDisplay: null }), {
    output: '/tmp/never.png', identifier: '180001c6', env: captureEnv,
  }), (error: Error & { code?: string }) => error.code === 'SCREENSHOT_FAILED')
})

test('orientImage rotates 180 degrees', () => {
  const rgba = new Uint8Array([
    1, 2, 3, 255, 4, 5, 6, 255,
    7, 8, 9, 255, 10, 11, 12, 255,
  ])
  const rotated = orientImage({ width: 2, height: 2, rgba }, 2)
  assert.deepEqual([...rotated.rgba], [
    10, 11, 12, 255, 7, 8, 9, 255,
    4, 5, 6, 255, 1, 2, 3, 255,
  ])
})

test('orientImage rotates 90 degrees counter-clockwise', () => {
  const rgba = new Uint8Array([1, 0, 0, 255, 2, 0, 0, 255])
  const rotated = orientImage({ width: 2, height: 1, rgba }, 1)
  assert.equal(rotated.width, 1)
  assert.equal(rotated.height, 2)
  assert.deepEqual([...rotated.rgba], [2, 0, 0, 255, 1, 0, 0, 255])
})
