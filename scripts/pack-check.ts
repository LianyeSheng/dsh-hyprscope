#!/usr/bin/env node
/**
 * Pack the package the way npm will publish it, unpack it into a throwaway
 * `node_modules/dsh-hyprscope`, and check the contracts a published bundle has
 * to keep:
 *
 *   1. the CLI runs from the packed tree (`node dist/bin/hyprscope.js -v`);
 *   2. the tarball ships the built tree under dist/ and no stale in-tree
 *      JavaScript from the old in-place emit;
 *   3. Node still refuses the `.ts` entry under `node_modules`, which is the
 *      reason dist/ exists at all;
 *   4. the DSH bundle contract holds: `dsh.bundle.patch` ships, the row name in
 *      that patch resolves back to the plugin entry through the package's own
 *      `exports`, and the plugin finds the CLI at `<package>/dist/bin/hyprscope.js`.
 *
 * It writes only under a temporary directory and prints a report; a failure
 * exits 1. Run it with `pnpm run pack:check`.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const report = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`)
  if (!ok) failures.push(message)
}

const work = mkdtempSync(join(tmpdir(), 'hyprscope-pack-'))
try {
  const packDir = join(work, 'pack')
  mkdirSync(packDir, { recursive: true })
  const output = execFileSync('pnpm', ['pack', '--pack-destination', packDir], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const tarball = output.trim().split(/\r?\n/).filter(Boolean).at(-1)
  if (!tarball || !existsSync(tarball)) throw new Error(`pnpm pack printed no tarball: ${output}`)
  // prepack builds dist/; postpack must remove it again so the checkout stays clean.
  report(!existsSync(join(repoRoot, 'dist')), 'postpack removed dist/ from the working tree')

  const app = join(work, 'app')
  const installed = join(app, 'node_modules', 'dsh-hyprscope')
  mkdirSync(installed, { recursive: true })
  execFileSync('tar', ['-xzf', tarball, '-C', installed, '--strip-components=1'])
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'pack-check-app', private: true }) + '\n')

  const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  report(pkg.private !== true, 'package is publishable (no "private": true)')
  report(typeof pkg.dsh?.bundle?.patch === 'string', 'package declares dsh.bundle.patch')
  report(pkg.bin?.hyprscope === './dist/bin/hyprscope.js', 'package bin points at the built CLI')

  const required = [
    'dist/bin/hyprscope.js',
    'dist/src/entry.js',
    'bin/hyprscope.ts',
    'overlay/shell.qml',
    'overlay/message/shell.qml',
    'overlay/message/AnnotateSurface.qml',
    'plugins/dsh-hyprscope/index.js',
    'plugins/dsh-hyprscope/message.js',
    'plugins/dsh-hyprscope/annotate.js',
    'plugins/dsh-hyprscope/voice.js',
    'plugins/dsh-hyprscope/icon.svg',
    'plugins/dsh-hyprscope/locale/en.json',
    'plugins/dsh-hyprscope/locale/zh.json',
  ]
  for (const file of required) report(existsSync(join(installed, file)), `tarball ships ${file}`)

  // The message surface resolves its QML directory from the package root, so
  // this is the check that catches a tarball which ships the code but not the
  // overlay it spawns.
  const messageOverlay = await import(pathToFileURL(join(installed, 'dist', 'src', 'message', 'overlay.js')).href)
  report(
    messageOverlay.messageOverlayDirectory() === join(installed, 'overlay', 'message'),
    'the message overlay resolves inside the packed tree',
  )

  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .map(entry => entry.replace(/^package\//, ''))
  report(!entries.includes('bin/hyprscope.js'), 'tarball leaves the stale in-tree bin/hyprscope.js out')
  report(!entries.some(entry => /^src\/.*\.js$/.test(entry)), 'tarball leaves stale src/**/*.js out')
  report(!/tools\/(capture|inject|scratch)\/generated/.test(entries.join('\n')), 'tarball leaves generated helper dirs out')

  // Node refuses to strip types under node_modules, so the shipped .ts entry is
  // unrunnable there: that is exactly why the build exists.
  const refused = spawnSync(process.execPath, [join(installed, 'bin', 'hyprscope.ts'), '-v'], {
    encoding: 'utf8', cwd: app,
  })
  report(refused.status !== 0, 'installed .ts entry is refused there (why dist exists)')
  report(
    /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/.test(refused.stderr ?? ''),
    "refusal is Node's node_modules type-stripping rule",
  )

  const version = execFileSync(process.execPath, [join(installed, 'dist', 'bin', 'hyprscope.js'), '-v'], {
    encoding: 'utf8',
    cwd: app,
  }).trim().split(/\s+/).at(-1)
  report(version === pkg.version, `CLI reports version ${version} from the packed tree`)

  const usage = execFileSync(process.execPath, [join(installed, 'dist', 'bin', 'hyprscope.js'), '-h'], {
    encoding: 'utf8',
    cwd: app,
  })
  report(/hyprscope/.test(usage), 'CLI prints usage from the packed tree')

  const plugin = await import(pathToFileURL(join(installed, 'plugins', 'dsh-hyprscope', 'index.js')).href)
  report(plugin.name === 'dsh-hyprscope', 'plugin exports name "dsh-hyprscope"')
  report(typeof plugin.apply === 'function', 'plugin exports apply()')

  const patchPath = join(installed, pkg.dsh.bundle.patch)
  report(existsSync(patchPath), `patch file ${pkg.dsh.bundle.patch} ships`)
  const rowName = readFileSync(patchPath, 'utf8').match(/^\s*name:\s*'?([^'\n]+)'?\s*$/m)?.[1]
  report(Boolean(rowName), 'patch declares a row name')

  if (rowName) {
    const require = createRequire(join(app, 'package.json'))
    const resolved = require.resolve(rowName)
    report(
      resolved === join(installed, 'plugins', 'dsh-hyprscope', 'index.js'),
      `patch row "${rowName}" resolves to the plugin entry from the profile`,
    )
  }
  report(
    existsSync(join(installed, 'dist', 'bin', 'hyprscope.js')),
    'plugin default projectDir (<plugin>/../..) holds the runnable dist entry',
  )
} finally {
  rmSync(work, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\npack:check passed')
