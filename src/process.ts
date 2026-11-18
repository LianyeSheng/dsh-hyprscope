/** Process liveness, shared by read-only target resolution and lease control. */

/**
 * @param pid Process id.
 * @returns Whether the process still exists.
 */
export function processAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
