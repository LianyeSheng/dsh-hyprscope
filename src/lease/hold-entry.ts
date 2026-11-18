#!/usr/bin/env node
/**
 * Internal detached lease-holder entry.
 *
 * The control CLI deliberately has no holder command: `spawnHolder` in
 * `control.ts` starts this module directly, and only it does. The holder keeps
 * an approved lease alive, refreshes its heartbeat, and finalizes the lease when
 * the run hands control back (`done` internally), the host revokes it (`panic`),
 * or the TTL expires. It is an implementation detail, not a CLI surface.
 */
import { holdLease } from './control.ts'

/**
 * Read the lease id from `--lease <id>` or `--lease=<id>`.
 * @param argv Arguments after the module path.
 * @returns The lease id, or null when the flag is missing or empty.
 */
function leaseIdFrom(argv: string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === '--lease') {
      const value = argv[index + 1]
      return value === undefined || value === '' ? null : value
    }
    if (argument.startsWith('--lease=')) {
      const value = argument.slice('--lease='.length)
      return value === '' ? null : value
    }
  }
  return null
}

const leaseId = leaseIdFrom(process.argv.slice(2))
if (leaseId === null) {
  process.stderr.write('hyprscope internal lease holder: --lease <id> is required\n')
  process.exitCode = 2
} else {
  try {
    await holdLease({ leaseId })
  } catch (error) {
    process.stderr.write(`hyprscope internal lease holder: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
