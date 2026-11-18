/** The single hyprscope entry point: observation by default, control only under `control`. */
import { main as observe } from './cli.ts'
import type { Io } from './cli.ts'

/**
 * Route one command line.
 *
 * The control surface is loaded dynamically and only when the first word is
 * exactly `control`. A read-only command therefore never imports the lease,
 * executor or desktop lifecycle code, and a mistyped control command never
 * silently runs down the observation path.
 * @param argv Arguments after the program name.
 * @param io Output targets.
 * @returns Process exit code.
 */
export async function main(
  argv: string[],
  io: Io = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  if (argv[0] === 'control') {
    const { main: control } = await import('./lease/cli.ts')
    return control(argv.slice(1), io)
  }
  return observe(argv, io)
}
