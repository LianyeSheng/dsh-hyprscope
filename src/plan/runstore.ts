/** Run artifacts: the approved plan, an append-only timeline, screenshots, and the final result. */
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { packageRoot } from '../paths.ts'
import { canonicalJson } from './canonical.ts'
import type { Plan } from './model.ts'

/** One timeline line. */
export interface TimelineEntry {
  at: string
  kind: string
  step?: number
  detail?: Record<string, unknown>
}

/**
 * Default directory that receives runs.
 * @param env Environment to read.
 * @returns Absolute directory path.
 */
export function defaultRunRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.HYPRSCOPE_RUN_DIR ?? join(packageRoot(), 'out', 'runs')
}

/**
 * Build a sortable, unique run id.
 * @param now Current time.
 * @returns `YYYYMMDDTHHMMSS-xxxxxx`.
 */
function newRunId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', 'T')
  const random = Math.random().toString(16).slice(2, 8)
  return `${stamp}-${random}`
}

/** Directory layout of one run. */
export class RunStore {
  readonly root: string
  readonly runId: string
  readonly dir: string
  readonly timelinePath: string

  /**
   * @param options Run root and optional explicit id, both injectable for tests.
   */
  constructor(options: { root?: string; runId?: string; now?: Date } = {}) {
    this.root = options.root ?? defaultRunRoot()
    this.runId = options.runId ?? newRunId(options.now ?? new Date())
    this.dir = join(this.root, this.runId)
    this.timelinePath = join(this.dir, 'timeline.jsonl')
  }

  /**
   * Create the run directory and persist the approved plan.
   * @param plan Validated plan.
   */
  async init(plan: Plan): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    await writeFile(join(this.dir, 'plan.json'), `${canonicalJson({ plan })}\n`, 'utf8')
  }

  /**
   * Append one timeline entry.
   * @param entry Entry to append.
   */
  async record(entry: TimelineEntry): Promise<void> {
    await appendFile(this.timelinePath, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  /**
   * Destination for one screenshot.
   * @param label Short label.
   * @param step Step index, or null for run-level captures.
   * @returns Absolute path.
   */
  screenshotPath(label: string, step: number | null): string {
    const prefix = step === null ? 'run' : `step-${String(step).padStart(2, '0')}`
    return join(this.dir, `${prefix}-${label}.png`)
  }

  /**
   * Write a JSON artifact.
   * @param name File name.
   * @param value JSON value.
   */
  async writeJson(name: string, value: unknown): Promise<void> {
    await writeFile(join(this.dir, name), `${canonicalJson(value)}\n`, 'utf8')
  }
}
