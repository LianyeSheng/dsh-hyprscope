/** The single hyprscope entry point: observation by default, control under `control`, desktop UI under `message`. */
import { main as observe } from './cli.ts'
import type { Io } from './cli.ts'

/**
 * Route one command line.
 *
 * The control surface is loaded dynamically and only when the first word is
 * exactly `control`; the desktop-message surface loads only under `message`.
 * A read-only command therefore never imports the lease, executor or desktop
 * lifecycle code, the message surface imports neither, and a mistyped control
 * command never silently runs down the observation path.
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
  if (argv[0] === 'message') {
    const { main: message } = await import('./message/cli.ts')
    return message(argv.slice(1), io)
  }
  return observe(argv, io)
}
