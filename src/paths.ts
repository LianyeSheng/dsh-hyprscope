/**
 * Package-root path resolution.
 *
 * Modules that read a file shipped beside the code (the overlay, the native
 * helpers, the `out/` artifact directories, `package.json`) resolve it through
 * the package root instead of counting `..` from their own URL. The build emits
 * the same modules one directory deeper, under `dist/`, and an installed copy
 * lives under `node_modules/`; a fixed depth would break in both places.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The package.json name this package must carry. */
const PACKAGE_NAME = 'dsh-hyprscope'

/** Cached root; the walk runs once per process. */
let cachedRoot: string | null = null

/**
 * Walk up from this module to the directory whose package.json names this package.
 *
 * The walk starts at this module's own URL, so it finds the root whether the
 * code runs from `<root>/src/paths.ts` in a checkout or from
 * `<root>/dist/src/paths.js` in an installed package. Requiring the matching
 * name keeps it from stopping at an unrelated manifest, such as the bundle's
 * own `plugins/dsh-hyprscope/package.json`.
 * @returns Absolute package root.
 */
export function packageRoot(): string {
  if (cachedRoot !== null) return cachedRoot
  const modulePath = fileURLToPath(import.meta.url)
  const stop = parse(dirname(modulePath)).root
  let directory = dirname(modulePath)
  for (;;) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown }
        if (parsed.name === PACKAGE_NAME) {
          cachedRoot = directory
          return cachedRoot
        }
      } catch {
        // An unreadable manifest is not the package root; keep walking.
      }
    }
    if (directory === stop) break
    directory = dirname(directory)
  }
  throw new Error(
    `hyprscope: cannot find the package root (a package.json named "${PACKAGE_NAME}") above ${modulePath}`,
  )
}

/**
 * Directory that holds native helpers and the TypeScript entry in a checkout.
 * @returns Absolute `<root>/bin` path; it may not exist before the helpers are built.
 */
export function binDir(): string {
  return join(packageRoot(), 'bin')
}

/**
 * Directory of the Quickshell consent overlay.
 * @returns Absolute `<root>/overlay` path.
 */
export function overlayDirectory(): string {
  return join(packageRoot(), 'overlay')
}

/** Cached version; `-v` and `doctor` read it on every process start. */
let cachedVersion: string | null = null

/**
 * Read this package's version from the root package.json.
 * @returns Version string, such as `0.2.0`.
 */
export function readPackageVersion(): string {
  if (cachedVersion !== null) return cachedVersion
  const manifest = join(packageRoot(), 'package.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch (error) {
    throw new Error(`hyprscope: cannot read the package version from ${manifest}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const version = (parsed as { version?: unknown } | null)?.version
  if (typeof version !== 'string' || version === '') {
    throw new Error(`hyprscope: ${manifest} carries no version`)
  }
  cachedVersion = version
  return cachedVersion
}
