/**
 * Human preview of a plan for the consent card.
 *
 * The overlay shows a submitted plan as one description line plus one line per
 * step, so the host approves "focus the terminal, click it, type this line,
 * capture the window" instead of "5 steps · click, text, screenshot". This
 * module owns that reading of a plan: it never changes the plan, never adds a
 * step the executor would not run, and never describes an op the catalog does
 * not know.
 */
import type { LeaseConfirmCard } from '../lease/state.ts'
import type { AnchorPoint, AbsolutePoint, Plan, PlanStep, StepOp, WindowTarget } from './model.ts'

/** Steps listed before the preview collapses the rest into a count. */
export const MAX_STEP_LINES = 10

/** Longest author-written summary kept in the description line. */
const MAX_SUMMARY_CHARS = 120
/** Longest quoted text, key sequence, or window title kept in one line. */
const MAX_QUOTE_CHARS = 28
/** Longest text step kept when the quote is clipped. */
const MAX_TEXT_CHARS = 120

/** One-phrase description of what an op does, used when the plan has no summary. */
const OP_VERBS: Readonly<Record<StepOp, string>> = {
  movePointer: '移动指针',
  click: '点击',
  scroll: '滚动',
  chord: '按键',
  text: '输入文本',
  focusWindow: '聚焦窗口',
  workspace: '切换工作区',
  moveWindow: '移动窗口',
  resizeWindow: '调整窗口大小',
  floatWindow: '设置窗口浮动',
  fullscreenWindow: '切换全屏',
  screenshot: '截图',
  pause: '等待',
  assert: '校验状态',
  waitEvent: '等待事件',
}

/** Display names for the mouse buttons a click step may use. */
const BUTTON_NAMES: Readonly<Record<string, string>> = {
  left: '左键',
  right: '右键',
  middle: '中键',
  back: '后退键',
  forward: '前进键',
}

/**
 * Clip one value to a quote-friendly length.
 * @param value Text to clip.
 * @param limit Maximum characters.
 * @returns Text that fits, with an ellipsis when clipped.
 */
function clip(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length <= limit ? compact : `${compact.slice(0, Math.max(1, limit - 1))}…`
}

/**
 * Describe a window selector in words.
 * @param target Selector, or undefined for "the target window".
 * @returns One phrase.
 */
function targetText(target: WindowTarget | undefined): string {
  if (target === undefined) return '目标窗口'
  if (target.id !== undefined) return `窗口 ${clip(target.id, 18)}`
  const app = target.app === undefined ? null : clip(target.app, MAX_QUOTE_CHARS)
  const title = target.title === undefined ? null : clip(target.title, MAX_QUOTE_CHARS)
  if (app !== null && title !== null) return `${app}「${title}」`
  if (app !== null) return `${app} 窗口`
  if (title !== null) return `标题含「${title}」的窗口`
  return '目标窗口'
}

/**
 * Describe a pointer position: absolute layout coordinates or a window anchor.
 * @param at Point from a step, or undefined when the step carries none.
 * @returns One phrase.
 */
function pointText(at: AnchorPoint | AbsolutePoint | undefined): string {
  if (at === undefined) return '指定位置'
  if ('point' in at) return `${targetText(at.window)} 内 (${at.point[0]}, ${at.point[1]})`
  return `(${Math.round(at.x)}, ${Math.round(at.y)})`
}

/**
 * Describe one validated step in one line.
 * @param step Validated plan step.
 * @param index Zero-based step index used to number the line.
 * @returns A line such as `2. click · 在 foot 窗口 内 (0.5, 0.6) 点击左键`.
 */
export function describeStep(step: PlanStep, index: number): string {
  const number = `${index + 1}.`
  switch (step.op) {
    case 'movePointer':
      return `${number} movePointer · 移动指针到 ${pointText(step.at)}`
    case 'click': {
      const button = BUTTON_NAMES[step.button ?? 'left'] ?? '左键'
      const count = (step.count ?? 1) > 1 ? ` ${step.count} 次` : ''
      return `${number} click · 在 ${pointText(step.at)} 点击${button}${count}`
    }
    case 'scroll':
      return `${number} scroll · 向${step.axis === 'horizontal' ? '右' : '下'}滚动 ${step.value ?? 0}`
    case 'chord':
      return `${number} chord · 按下 ${clip((step.keys ?? []).join(' + '), MAX_QUOTE_CHARS)}`
    case 'text':
      return `${number} text · 输入「${clip(step.text ?? '', MAX_TEXT_CHARS)}」`
    case 'focusWindow':
      return `${number} focusWindow · 聚焦 ${targetText(step.target)}`
    case 'workspace':
      return `${number} workspace · 切换到工作区 ${clip(step.name ?? '', MAX_QUOTE_CHARS)}`
    case 'moveWindow':
      return `${number} moveWindow · 把 ${targetText(step.target)} 移到 (${step.x ?? 0}, ${step.y ?? 0})`
    case 'resizeWindow':
      return `${number} resizeWindow · 把 ${targetText(step.target)} 调整为 ${step.width ?? 0}×${step.height ?? 0}`
    case 'floatWindow': {
      const parts: string[] = []
      if (step.floating !== undefined) parts.push(step.floating ? '浮动' : '取消浮动')
      if (step.pinned !== undefined) parts.push(step.pinned ? '置顶' : '取消置顶')
      return `${number} floatWindow · ${targetText(step.target)} ${parts.join('、')}`
    }
    case 'fullscreenWindow': {
      const internal = step.internal ?? 0
      const client = step.client ?? 0
      return `${number} fullscreenWindow · ${targetText(step.target)} 全屏 内部=${internal} 客户端=${client}`
    }
    case 'screenshot': {
      const label = step.label === undefined ? '' : `「${clip(step.label, MAX_QUOTE_CHARS)}」`
      const region = step.region === undefined ? '' : `（${targetText(step.region.window)} 区域）`
      return `${number} screenshot · 截图${label}${region}`
    }
    case 'pause':
      return `${number} pause · 等待 ${step.ms ?? 0} ms`
    case 'assert': {
      const kinds = (step.requires ?? []).map(predicate => predicate.kind)
      return `${number} assert · 校验 ${kinds.length === 0 ? '状态' : kinds.join('、')}`
    }
    case 'waitEvent':
      return `${number} waitEvent · 等待 ${step.kind ?? '事件'} 事件（最多 ${step.timeoutMs ?? 0} ms）`
    default:
      // Validation only builds catalog ops, so this arm is unreachable; keep the
      // line honest instead of inventing a description for an unknown op.
      return `${number} ${String((step as { op?: unknown }).op ?? 'unknown')} · 未知操作`
  }
}

/** Presentation overrides for a plan card; the defaults are the agent-run card. */
export interface PlanCardOptions {
  /** Card title; the probe uses its own because it asks for measurement, not a run. */
  title?: string
  /** Label of the allow button. */
  acceptLabel?: string
  /** Label of the deny button. */
  denyLabel?: string
}

/**
 * Build the consent card for one submitted plan.
 *
 * The first line says what the plan does as a whole (the author's summary when
 * there is one, otherwise the distinct verbs of its ops). Then one line per step
 * follows, capped so a 64-step plan cannot push the buttons off screen.
 * @param plan Validated plan the host is asked to approve.
 * @param options Title and button labels, for a caller that is not an agent run.
 * @returns Card content for the overlay.
 */
export function describePlanCard(plan: Plan, options: PlanCardOptions = {}): LeaseConfirmCard {
  const verbs = [...new Set(plan.steps.map(step => OP_VERBS[step.op]))]
  const description = plan.summary === null || plan.summary.trim() === ''
    ? (verbs.length === 0 ? '没有步骤' : verbs.join(' → '))
    : clip(plan.summary, MAX_SUMMARY_CHARS)
  const seconds = (plan.budgetMs / 1000).toFixed(plan.budgetMs % 1000 === 0 ? 0 : 1)
  const lines = [
    `计划 ${plan.id}：${description}`,
    `共 ${plan.steps.length} 步 · 预算 ${seconds} 秒${plan.workspace === null ? '' : ` · 工作区 ${plan.workspace}`}`,
    ...plan.steps.slice(0, MAX_STEP_LINES).map((step, index) => describeStep(step, index)),
  ]
  const hidden = plan.steps.length - MAX_STEP_LINES
  if (hidden > 0) lines.push(`…还有 ${hidden} 步未显示，完整步骤见执行回执`)
  return {
    title: options.title ?? 'Agent 请求执行计划',
    lines,
    acceptLabel: options.acceptLabel ?? '允许操控',
    denyLabel: options.denyLabel ?? '拒绝',
  }
}
