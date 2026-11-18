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
import { tr, type RenderLanguage } from '../i18n.ts'
import type { LeaseConfirmCard } from '../lease/state.ts'
import {
  planTextFor, type AnchorPoint, type AbsolutePoint, type Plan, type PlanStep, type StepOp, type WindowTarget,
} from './model.ts'

/** Steps listed before the preview collapses the rest into a count. */
export const MAX_STEP_LINES = 10

/** Longest author-written summary kept in the description line. */
const MAX_SUMMARY_CHARS = 120
/** Longest quoted text, key sequence, or window title kept in one line. */
const MAX_QUOTE_CHARS = 28
/** Longest text step kept when the quote is clipped. */
const MAX_TEXT_CHARS = 120

/** One-phrase description of what an op does, per language. */
const OP_VERBS: Readonly<Record<StepOp, [string, string]>> = {
  movePointer: ['移动指针', 'move the pointer'],
  click: ['点击', 'click'],
  scroll: ['滚动', 'scroll'],
  chord: ['按键', 'press keys'],
  text: ['输入文本', 'type text'],
  focusWindow: ['聚焦窗口', 'focus a window'],
  workspace: ['切换工作区', 'switch workspace'],
  moveWindow: ['移动窗口', 'move a window'],
  resizeWindow: ['调整窗口大小', 'resize a window'],
  floatWindow: ['设置窗口浮动', 'change window floating'],
  fullscreenWindow: ['切换全屏', 'change fullscreen'],
  screenshot: ['截图', 'capture'],
  pause: ['等待', 'wait'],
  assert: ['校验状态', 'verify state'],
  waitEvent: ['等待事件', 'wait for an event'],
}

/** Display names for the mouse buttons a click step may use, per language. */
const BUTTON_NAMES: Readonly<Record<string, [string, string]>> = {
  left: ['左键', 'left button'],
  right: ['右键', 'right button'],
  middle: ['中键', 'middle button'],
  back: ['后退键', 'back button'],
  forward: ['前进键', 'forward button'],
}

/**
 * Pick one phrasing from a pair.
 * @param pair [Chinese, English] strings.
 * @param lang Render language.
 * @returns The text for that language.
 */
function pair(value: [string, string], lang: RenderLanguage): string {
  return lang === 'zh' ? value[0] : value[1]
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
 * @param lang Render language.
 * @returns One phrase.
 */
function targetText(target: WindowTarget | undefined, lang: RenderLanguage): string {
  const fallback = tr(lang, '目标窗口', 'the target window')
  if (target === undefined) return fallback
  if (target.id !== undefined) return tr(lang, `窗口 ${clip(target.id, 18)}`, `window ${clip(target.id, 18)}`)
  const app = target.app === undefined ? null : clip(target.app, MAX_QUOTE_CHARS)
  const title = target.title === undefined ? null : clip(target.title, MAX_QUOTE_CHARS)
  if (app !== null && title !== null) {
    return tr(lang, `${app}「${title}」`, `${app} "${title}"`)
  }
  if (app !== null) return tr(lang, `${app} 窗口`, `the ${app} window`)
  if (title !== null) return tr(lang, `标题含「${title}」的窗口`, `the window titled "${title}"`)
  return fallback
}

/**
 * Name the window a capture targets, for the card line.
 * @param target Selector the screenshot names.
 * @param lang Render language.
 * @returns One short quoted name.
 */
function captureName(target: WindowTarget, lang: RenderLanguage): string {
  if (target.app !== undefined) return clip(target.app, MAX_QUOTE_CHARS)
  if (target.title !== undefined) return clip(target.title, MAX_QUOTE_CHARS)
  if (target.id !== undefined) return clip(target.id, 18)
  return tr(lang, '目标窗口', 'the target window')
}

/**
 * Describe a pointer position: absolute layout coordinates or a window anchor.
 * @param at Point from a step, or undefined when the step carries none.
 * @param lang Render language.
 * @returns One phrase.
 */
function pointText(at: AnchorPoint | AbsolutePoint | undefined, lang: RenderLanguage): string {
  if (at === undefined) return tr(lang, '指定位置', 'the given position')
  if ('point' in at) {
    return tr(lang, `${targetText(at.window, lang)} 内 (${at.point[0]}, ${at.point[1]})`,
      `inside ${targetText(at.window, lang)} at (${at.point[0]}, ${at.point[1]})`)
  }
  return `(${Math.round(at.x)}, ${Math.round(at.y)})`
}

/**
 * Describe one validated step in one line.
 * @param step Validated plan step.
 * @param index Zero-based step index used to number the line.
 * @param lang Render language; defaults to Chinese.
 * @returns A line such as `2. click · 在 foot 窗口 内 (0.5, 0.6) 点击左键`.
 */
export function describeStep(step: PlanStep, index: number, lang: RenderLanguage = 'zh'): string {
  const number = `${index + 1}.`
  switch (step.op) {
    case 'movePointer': {
      const where = pointText(step.at, lang)
      const english = step.at !== undefined && 'point' in step.at
        ? `move the pointer ${where}`
        : `move the pointer to ${where}`
      return `${number} movePointer · ${tr(lang, `移动指针到 ${where}`, english)}`
    }
    case 'click': {
      const button = pair(BUTTON_NAMES[step.button ?? 'left'] ?? BUTTON_NAMES.left!, lang)
      const count = (step.count ?? 1) > 1
        ? tr(lang, ` ${step.count} 次`, ` ${step.count} times`)
        : ''
      const where = pointText(step.at, lang)
      const english = step.at !== undefined && 'point' in step.at
        ? `click the ${button} ${where}${count}`
        : `click the ${button} at ${where}${count}`
      return `${number} click · ${tr(lang, `在 ${where} 点击${button}${count}`, english)}`
    }
    case 'scroll':
      return `${number} scroll · ${tr(lang,
        `向${step.axis === 'horizontal' ? '右' : '下'}滚动 ${step.value ?? 0}`,
        `scroll ${step.axis === 'horizontal' ? 'right' : 'down'} ${step.value ?? 0}`)}`
    case 'chord':
      return `${number} chord · ${tr(lang, `按下 ${clip((step.keys ?? []).join(' + '), MAX_QUOTE_CHARS)}`,
        `press ${clip((step.keys ?? []).join(' + '), MAX_QUOTE_CHARS)}`)}`
    case 'text':
      return `${number} text · ${tr(lang, `输入「${clip(step.text ?? '', MAX_TEXT_CHARS)}」`,
        `type "${clip(step.text ?? '', MAX_TEXT_CHARS)}"`)}`
    case 'focusWindow':
      return `${number} focusWindow · ${tr(lang, `聚焦 ${targetText(step.target, lang)}`, `focus ${targetText(step.target, lang)}`)}`
    case 'workspace':
      return `${number} workspace · ${tr(lang, `切换到工作区 ${clip(step.name ?? '', MAX_QUOTE_CHARS)}`,
        `switch to workspace "${clip(step.name ?? '', MAX_QUOTE_CHARS)}"`)}`
    case 'moveWindow':
      return `${number} moveWindow · ${tr(lang,
        `把 ${targetText(step.target, lang)} 移到 (${step.x ?? 0}, ${step.y ?? 0})`,
        `move ${targetText(step.target, lang)} to (${step.x ?? 0}, ${step.y ?? 0})`)}`
    case 'resizeWindow':
      return `${number} resizeWindow · ${tr(lang,
        `把 ${targetText(step.target, lang)} 调整为 ${step.width ?? 0}×${step.height ?? 0}`,
        `resize ${targetText(step.target, lang)} to ${step.width ?? 0}×${step.height ?? 0}`)}`
    case 'floatWindow': {
      const parts: string[] = []
      if (step.floating !== undefined) parts.push(tr(lang, step.floating ? '浮动' : '取消浮动', step.floating ? 'float' : 'tile'))
      if (step.pinned !== undefined) parts.push(tr(lang, step.pinned ? '置顶' : '取消置顶', step.pinned ? 'pin' : 'unpin'))
      return `${number} floatWindow · ${targetText(step.target, lang)} ${parts.join(tr(lang, '、', ', '))}`
    }
    case 'fullscreenWindow': {
      const internal = step.internal ?? 0
      const client = step.client ?? 0
      return `${number} fullscreenWindow · ${tr(lang,
        `${targetText(step.target, lang)} 全屏 内部=${internal} 客户端=${client}`,
        `fullscreen ${targetText(step.target, lang)} (internal=${internal}, client=${client})`)}`
    }
    case 'screenshot': {
      if (step.window !== undefined) {
        return `${number} screenshot · ${tr(lang, `截图窗口「${captureName(step.window, lang)}」`,
          `capture the window "${captureName(step.window, lang)}"`)}`
      }
      const label = step.label === undefined ? '' : tr(lang, `「${clip(step.label, MAX_QUOTE_CHARS)}」`,
        ` "${clip(step.label, MAX_QUOTE_CHARS)}"`)
      const region = step.region === undefined ? '' : tr(lang, `（${targetText(step.region.window, lang)} 区域）`,
        ` (a region of ${targetText(step.region.window, lang)})`)
      return `${number} screenshot · ${tr(lang, `截图${label}${region}`, `capture${label}${region}`)}`
    }
    case 'pause':
      return `${number} pause · ${tr(lang, `等待 ${step.ms ?? 0} ms`, `wait ${step.ms ?? 0} ms`)}`
    case 'assert': {
      const kinds = (step.requires ?? []).map(predicate => predicate.kind)
      return `${number} assert · ${tr(lang, `校验 ${kinds.length === 0 ? '状态' : kinds.join('、')}`,
        `verify ${kinds.length === 0 ? 'state' : kinds.join(', ')}`)}`
    }
    case 'waitEvent':
      return `${number} waitEvent · ${tr(lang, `等待 ${step.kind ?? '事件'} 事件（最多 ${step.timeoutMs ?? 0} ms）`,
        `wait for a ${step.kind ?? 'event'} event (up to ${step.timeoutMs ?? 0} ms)`)}`
    default:
      // Validation only builds catalog ops, so this arm is unreachable; keep the
      // line honest instead of inventing a description for an unknown op.
      return `${number} ${String((step as { op?: unknown }).op ?? 'unknown')} · ${tr(lang, '未知操作', 'unknown operation')}`
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
  /** Render language for the description lines and the default labels. */
  lang?: RenderLanguage
}

/**
 * Build the consent card for one submitted plan.
 *
 * The first line says what the plan does as a whole (the author's summary when
 * there is one, otherwise the distinct verbs of its ops). Then one line per step
 * follows, capped so a 64-step plan cannot push the buttons off screen.
 * @param plan Validated plan the host is asked to approve.
 * @param options Title, button labels and language for a caller that is not an agent run.
 * @returns Card content for the overlay.
 */
export function describePlanCard(plan: Plan, options: PlanCardOptions = {}): LeaseConfirmCard {
  const lang: RenderLanguage = options.lang ?? 'zh'
  const verbs = [...new Set(plan.steps.map(step => pair(OP_VERBS[step.op], lang)))]
  // An authored summary may be one string or per-language variants; the card
  // always reads the variant for the language it is rendering.
  const authored = plan.summary === null ? null : planTextFor(plan.summary, lang)
  const description = authored === null || authored.trim() === ''
    ? (verbs.length === 0 ? tr(lang, '没有步骤', 'no steps') : verbs.join(' → '))
    : clip(authored, MAX_SUMMARY_CHARS)
  const seconds = (plan.budgetMs / 1000).toFixed(plan.budgetMs % 1000 === 0 ? 0 : 1)
  const stepWord = plan.steps.length === 1 ? 'step' : 'steps'
  const lines = [
    tr(lang, `计划 ${plan.id}：${description}`, `Plan ${plan.id}: ${description}`),
    tr(lang,
      `共 ${plan.steps.length} 步 · 预算 ${seconds} 秒${plan.workspace === null ? '' : ` · 工作区 ${plan.workspace}`}`,
      `${plan.steps.length} ${stepWord} · budget ${seconds} s${plan.workspace === null ? '' : ` · workspace ${plan.workspace}`}`),
    ...plan.steps.slice(0, MAX_STEP_LINES).map((step, index) => describeStep(step, index, lang)),
  ]
  const hidden = plan.steps.length - MAX_STEP_LINES
  if (hidden > 0) {
    lines.push(tr(lang, `…还有 ${hidden} 步未显示，完整步骤见执行回执`,
      `…${hidden} more steps are not shown; see the run receipt for the full list`))
  }
  return {
    title: options.title ?? tr(lang, 'Agent 请求执行计划', 'Agent requests to run a plan'),
    lines,
    acceptLabel: options.acceptLabel ?? tr(lang, '允许操控', 'Allow control'),
    denyLabel: options.denyLabel ?? tr(lang, '拒绝', 'Deny'),
  }
}
