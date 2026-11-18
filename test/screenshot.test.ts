/** PNG header parsing, region validation, and capture wiring through a fake grim. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  capture, captureDirectory, defaultCapturePath, parseRegion, pngDimensions, preflightCaptureOutput,
} from '../src/screenshot.ts'
import { fakeSession, makePng, removeDir, tempDir, writeScript } from './support.ts'

test('pngDimensions reads IHDR width and height', () => {
  assert.deepEqual(pngDimensions(makePng(2560, 1440)), { width: 2560, height: 1440, bitDepth: 8, colorType: 6 })
})

test('pngDimensions rejects non-PNG bytes', () => {
  assert.throws(() => pngDimensions(Buffer.from('GIF89a')),
    (error: Error & { code?: string }) => error.code === 'SCREENSHOT_FAILED')
})

test('pngDimensions rejects a PNG without IHDR', () => {
  const broken = Buffer.alloc(40)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(broken, 0)
  broken.write('IDAT', 12, 'latin1')
  assert.throws(() => pngDimensions(broken),
    (error: Error & { code?: string }) => error.code === 'SCREENSHOT_FAILED')
})

test('parseRegion reads global layout coordinates', () => {
  assert.deepEqual(parseRegion('10,20,300,400'), { x: 10, y: 20, width: 300, height: 400 })
  assert.deepEqual(parseRegion(' -5 , 0 , 1 , 1 '), { x: -5, y: 0, width: 1, height: 1 })
})

test('parseRegion rejects malformed and empty regions', () => {
  for (const region of ['1,2,3', '1,2,0,4', 'a,b,c,d', '1,2,3,4,5']) {
    assert.throws(() => parseRegion(region), (error: Error & { code?: string }) => error.code === 'USAGE', region)
  }
})

test('captureDirectory honours XDG_CACHE_HOME', () => {
  assert.equal(captureDirectory({ XDG_CACHE_HOME: '/tmp/cache' }), '/tmp/cache/hyprscope')
})

test('defaultCapturePath stamps the cache directory', () => {
  const path = defaultCapturePath({ XDG_CACHE_HOME: '/tmp/cache' }, new Date('2026-01-02T03:04:05.678Z'))
  assert.equal(path, '/tmp/cache/hyprscope/screenshot-2026-01-02T03-04-05-678Z.png')
})

/** Fake grim fixture paths. */
interface GrimFixture {
  script: string
  args: string
  png: string
}

/**
 * Build a fake grim that copies a fixture and records its arguments.
 * @param directory Fixture directory.
 * @returns Script, argument log, and PNG fixture paths.
 */
function fakeGrim(directory: string): GrimFixture {
  const png = join(directory, 'fixture.png')
  writeFileSync(png, makePng(640, 480))
  const args = join(directory, 'grim.args')
  const script = writeScript(directory, 'grim', [
    '#!/bin/sh',
    'for last; do :; done',
    `cp "${png}" "$last"`,
    `printf '%s\\n' "$@" > "${args}"`,
    '',
  ].join('\n'))
  return { script, args, png }
}

const captureEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  XDG_RUNTIME_DIR: '/run/user/1000',
  WAYLAND_DISPLAY: 'wayland-1',
}

test('capture writes a PNG and reports geometry for a region', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const grim = fakeGrim(directory)
  const output = join(directory, 'capture.png')
  const result = await capture(fakeSession(), {
    output, region: { x: 10, y: 20, width: 300, height: 400 }, binary: grim.script, env: captureEnv,
  })
  assert.equal(result.path, output)
  assert.equal(result.width, 640)
  assert.equal(result.height, 480)
  assert.equal(result.source.scope, 'region')
  assert.equal(result.source.window, null)
  assert.deepEqual(result.source.region, { x: 10, y: 20, width: 300, height: 400 })
  assert.equal(result.sha256, createHash('sha256').update(readFileSync(output)).digest('hex'))
  const args = readFileSync(grim.args, 'utf8').trim().split('\n')
  assert.deepEqual(args, ['-g', '10,20 300x400', output])
})

test('capture targets one monitor', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const grim = fakeGrim(directory)
  const output = join(directory, 'monitor.png')
  const result = await capture(fakeSession(), {
    output, monitor: 'HDMI-A-1', binary: grim.script, env: captureEnv,
  })
  assert.equal(result.source.scope, 'monitor')
  assert.equal(result.source.monitor, 'HDMI-A-1')
  const args = readFileSync(grim.args, 'utf8').trim().split('\n')
  assert.deepEqual(args, ['-o', 'HDMI-A-1', output])
})

test('capture refuses conflicting sources and missing displays', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const grim = fakeGrim(directory)
  await assert.rejects(capture(fakeSession(), {
    output: join(directory, 'x.png'), monitor: 'HDMI-A-1', region: { x: 0, y: 0, width: 1, height: 1 }, binary: grim.script,
  }), (error: Error & { code?: string }) => error.code === 'USAGE')
  await assert.rejects(capture(fakeSession({ waylandDisplay: null }), {
    output: join(directory, 'y.png'), binary: grim.script,
  }), (error: Error & { code?: string }) => error.code === 'SCREENSHOT_FAILED')
  assert.equal(existsSync(join(directory, 'x.png')), false)
})


const isRoot = typeof process.getuid === 'function' && process.getuid() === 0

test('preflightCaptureOutput accepts an existing writable directory and writes nothing', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  await preflightCaptureOutput(join(directory, 'capture.png'))
  assert.deepEqual(readdirSync(directory), [])
})

test('preflightCaptureOutput refuses a missing directory with the --output hint', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  await assert.rejects(preflightCaptureOutput(join(directory, 'missing', 'capture.png')),
    (error: Error & { code?: string; message: string; details?: { directory?: string } }) => {
      assert.equal(error.code, 'SCREENSHOT_FAILED')
      assert.match(error.message, /pass --output <writable path>/)
      assert.equal(error.details?.directory, join(directory, 'missing'))
      return true
    })
  assert.equal(existsSync(join(directory, 'missing')), false, 'preflight must not create an explicit output directory')
})

test('preflightCaptureOutput refuses an unwritable directory', { skip: isRoot ? 'running as root ignores mode bits' : false }, async (t) => {
  const directory = tempDir()
  t.after(() => { chmodSync(directory, 0o755); removeDir(directory) })
  chmodSync(directory, 0o500)
  await assert.rejects(preflightCaptureOutput(join(directory, 'capture.png')),
    (error: Error & { code?: string; message: string }) => {
      assert.equal(error.code, 'SCREENSHOT_FAILED')
      assert.match(error.message, /not writable.*pass --output <writable path>/)
      return true
    })
})

test('preflightCaptureOutput creates the default cache directory', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const output = join(directory, 'cache', 'hyprscope', 'capture.png')
  await preflightCaptureOutput(output, { create: true })
  assert.equal(existsSync(join(directory, 'cache', 'hyprscope')), true)
})

test('capture refuses an explicit output in a missing directory before running grim', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const grim = fakeGrim(directory)
  const output = join(directory, 'missing', 'capture.png')
  await assert.rejects(capture(fakeSession(), { output, binary: grim.script, env: captureEnv }),
    (error: Error & { code?: string; message: string }) => {
      assert.equal(error.code, 'SCREENSHOT_FAILED')
      assert.match(error.message, /pass --output <writable path>/)
      return true
    })
  assert.equal(existsSync(join(directory, 'missing')), false)
  assert.equal(existsSync(grim.args), false, 'grim must not run when the destination is unusable')
})

test('capture still creates the default XDG_CACHE_HOME directory', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const grim = fakeGrim(directory)
  const cache = join(directory, 'cache')
  const now = new Date('2026-01-02T03:04:05.678Z')
  const result = await capture(fakeSession(), {
    binary: grim.script, env: { ...captureEnv, XDG_CACHE_HOME: cache }, now,
  })
  assert.equal(result.path, join(cache, 'hyprscope', 'screenshot-2026-01-02T03-04-05-678Z.png'))
  assert.equal(existsSync(result.path), true)
})

test('capture reports a failing grim run', async (t) => {
  const directory = tempDir()
  t.after(() => removeDir(directory))
  const script = writeScript(directory, 'grim', '#!/bin/sh\necho "compositor does not support screencopy" >&2\nexit 1\n')
  await assert.rejects(capture(fakeSession(), {
    output: join(directory, 'z.png'), binary: script, env: captureEnv,
  }), (error: Error & { code?: string; details?: { stderr?: string } }) => {
    assert.equal(error.code, 'SCREENSHOT_FAILED')
    assert.ok(error.details?.stderr?.includes('screencopy'))
    return true
  })
})
