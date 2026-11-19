#!/usr/bin/env node
/**
 * Remove the JavaScript tree that `pnpm run build` emits into `dist/`.
 *
 * The build exists only so `npm publish` ships runnable files: Node refuses to
 * strip types under `node_modules`, so an installed copy must be `.js`.
 * `prepack` builds dist/, `postpack` calls this script, and the checkout goes
 * back to being TypeScript-only. Only a directory that carries the two entry
 * points this build always writes is removed, so a hand-written or unrelated
 * `dist/` is never deleted.
 */
import { existsSync, lstatSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { packageRoot } from '../src/paths.ts'

/** Files `tsc -p tsconfig.build.json` always writes; their absence means "not ours". */
const BUILD_MARKERS = ['bin/hyprscope.js', 'src/entry.js']

const dist = join(packageRoot(), 'dist')

if (!existsSync(dist)) {
  console.log('clean:dist: nothing to remove (dist/ is absent)')
} else {
  const status = lstatSync(dist)
  const isOurs = status.isDirectory() && !status.isSymbolicLink()
    && BUILD_MARKERS.every(marker => existsSync(join(dist, marker)))
  if (!isOurs) {
    console.error(`clean:dist: refusing to remove ${dist}: it does not hold this build's entry points`)
    process.exitCode = 1
  } else {
    rmSync(dist, { recursive: true, force: true })
    console.log(`clean:dist removed ${dist}`)
  }
}
