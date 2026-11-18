/** The consent card reads a plan as a description line plus one line per step. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describePlanCard, describeStep, MAX_STEP_LINES } from '../src/plan/card.ts'
import type { Plan } from '../src/plan/model.ts'
import { validatePlan } from '../src/plan/validate.ts'

/**
 * Validate one plan document so the card reads the same object the executor runs.
 * @param steps Raw steps.
 * @param extra Plan-level fields to override.
 * @returns Validated plan.
 */
function planOf(steps: unknown[], extra: Record<string, unknown> = {}): Plan {
  return validatePlan({ version: 1, id: 'act', reason: 'test plan', steps, ...extra })
}

test('a one-step plan explains the step and the budget', () => {
  const card = describePlanCard(planOf([{ op: 'movePointer', at: { x: 1280, y: 720 } }]))
  assert.equal(card.title, 'Agent 请求执行计划')
  assert.equal(card.acceptLabel, '允许操控')
  assert.equal(card.denyLabel, '拒绝')
  assert.deepEqual(card.lines, [
    '计划 act：移动指针',
    '共 1 步 · 预算 8 秒',
    '1. movePointer · 移动指针到 (1280, 720)',
  ])
})

test('an authored summary is the description line', () => {
  const card = describePlanCard(planOf([{ op: 'pause', ms: 50 }], {
    summary: '聚焦终端、点一下、输入一行、截图',
  }))
  assert.equal(card.lines[0], '计划 act：聚焦终端、点一下、输入一行、截图')
  assert.equal(card.lines[1], '共 1 步 · 预算 8 秒')
})

test('each step keeps its own meaning: focus, click, text, chord, capture', () => {
  const plan = planOf([
    {
      op: 'focusWindow', target: { app: 'foot' },
      requires: [{ kind: 'window.exists', target: { app: 'foot' } }],
      expect: [{ kind: 'window.focused', target: { app: 'foot' } }],
    },
    {
      op: 'click', at: { window: { app: 'foot' }, point: [0.5, 0.6] }, button: 'right',
      requires: [{ kind: 'window.focused', target: { app: 'foot' } }, { kind: 'window.geometry', target: { app: 'foot' } }],
      expect: [{ kind: 'window.focused', target: { app: 'foot' } }],
    },
    {
      op: 'text', text: 'echo hyprscope-live',
      requires: [{ kind: 'window.focused', target: { app: 'foot' } }],
      expect: [{ kind: 'region.changed', target: { app: 'foot' }, rect: [0.02, 0.02, 0.96, 0.9] }],
    },
    {
      op: 'chord', keys: ['Control', 'Return'],
      requires: [{ kind: 'window.focused', target: { app: 'foot' } }],
      expect: [{ kind: 'region.changed', target: { app: 'foot' }, rect: [0.02, 0.02, 0.96, 0.9] }],
    },
    { op: 'screenshot', label: 'terminal', region: { window: { app: 'foot' }, rect: [0, 0, 1, 1] } },
  ], { summary: 'type one line into a terminal' })
  const card = describePlanCard(plan)
  assert.deepEqual(card.lines.slice(2), [
    '1. focusWindow · 聚焦 foot 窗口',
    '2. click · 在 foot 窗口 内 (0.5, 0.6) 点击右键',
    '3. text · 输入「echo hyprscope-live」',
    '4. chord · 按下 Control + Return',
    '5. screenshot · 截图「terminal」（foot 窗口 区域）',
  ])
})

test('a window screenshot names the captured window, not a region', () => {
  const byApp = describePlanCard(planOf([{ op: 'screenshot', label: 'zen', window: { app: 'zen' } }]))
  assert.equal(byApp.lines[2], '1. screenshot · 截图窗口「zen」')
  const byTitle = describePlanCard(planOf([{ op: 'screenshot', window: { title: 'demo' } }]))
  assert.equal(byTitle.lines[2], '1. screenshot · 截图窗口「demo」')
})

test('window targets, workspace, and the budget line are readable', () => {
  const card = describePlanCard(planOf([
    { op: 'focusWindow', target: { app: 'foot', title: 'zsh - demo' }, requires: [{ kind: 'window.exists', target: { app: 'foot' } }] },
    { op: 'workspace', name: 'dev' },
    {
      op: 'moveWindow', target: { id: '0x560360bcec90' }, x: 100, y: 200,
      requires: [{ kind: 'window.exists', target: { id: '0x560360bcec90' } }],
    },
    {
      op: 'resizeWindow', target: { id: '0x560360bcec90' }, width: 640, height: 480,
      requires: [{ kind: 'window.exists', target: { id: '0x560360bcec90' } }],
    },
    {
      op: 'floatWindow', target: { id: '0x560360bcec90' }, floating: true, pinned: false,
      requires: [{ kind: 'window.exists', target: { id: '0x560360bcec90' } }],
    },
    {
      op: 'fullscreenWindow', target: { id: '0x560360bcec90' }, internal: 1,
      requires: [{ kind: 'window.exists', target: { id: '0x560360bcec90' } }],
    },
    {
      op: 'scroll', value: -3, axis: 'horizontal',
      requires: [{ kind: 'window.focused', target: { id: '0x560360bcec90' } }],
      expect: [{ kind: 'window.focused', target: { id: '0x560360bcec90' } }],
    },
    { op: 'waitEvent', kind: 'openwindow', timeoutMs: 500 },
    { op: 'assert', requires: [{ kind: 'window.focused', target: { id: '0x560360bcec90' } }] },
  ], { budgetMs: 12_500, workspace: 'dev' }))
  const text = card.lines.join('\n')
  assert.match(text, /共 9 步 · 预算 12\.5 秒 · 工作区 dev/)
  assert.match(text, /focusWindow · 聚焦 foot「zsh - demo」/)
  assert.match(text, /workspace · 切换到工作区 dev/)
  assert.match(text, /moveWindow · 把 窗口 0x560360bcec90 移到 \(100, 200\)/)
  assert.match(text, /resizeWindow · 把 窗口 0x560360bcec90 调整为 640×480/)
  assert.match(text, /floatWindow · 窗口 0x560360bcec90 浮动、取消置顶/)
  assert.match(text, /fullscreenWindow · 窗口 0x560360bcec90 全屏 内部=1 客户端=0/)
  assert.match(text, /scroll · 向右滚动 -3/)
  assert.match(text, /waitEvent · 等待 openwindow 事件（最多 500 ms）/)
  assert.match(text, /assert · 校验 window\.focused/)
})

test('a long plan shows MAX_STEP_LINES steps and counts the rest', () => {
  const steps = Array.from({ length: MAX_STEP_LINES + 2 }, () => ({ op: 'pause', ms: 10 }))
  const card = describePlanCard(planOf(steps))
  assert.equal(card.lines.length, 2 + MAX_STEP_LINES + 1)
  assert.match(card.lines.at(-1) ?? '', /^…还有 2 步未显示/)
})

test('a long text and summary are clipped, not dropped', () => {
  const card = describePlanCard(planOf([{
    op: 'text', text: 'x'.repeat(300),
    requires: [{ kind: 'window.focused', target: { app: 'foot' } }],
    expect: [{ kind: 'region.changed', target: { app: 'foot' }, rect: [0, 0, 1, 1] }],
  }], { summary: 'y'.repeat(180) }))
  const description = card.lines[0] ?? ''
  const textLine = card.lines[2] ?? ''
  assert.ok(description.endsWith('…'))
  assert.ok(description.length < 140)
  assert.ok(textLine.includes('…'))
  assert.ok(textLine.length < 150)
})

test('describeStep names an anchored pointer without absolute coordinates', () => {
  const plan = planOf([{ op: 'movePointer', at: { window: { title: 'demo' }, point: [0.25, 0.75] } }])
  assert.equal(describeStep(plan.steps[0]!, 0), '1. movePointer · 移动指针到 标题含「demo」的窗口 内 (0.25, 0.75)')
})
test('the card renders English when the caller asks for it', () => {
  const card = describePlanCard(planOf([{ op: 'movePointer', at: { x: 100, y: 200 } }], { summary: 'open the menu' }), {
    lang: 'en',
  })
  assert.equal(card.title, 'Agent requests to run a plan')
  assert.equal(card.acceptLabel, 'Allow control')
  assert.equal(card.denyLabel, 'Deny')
  assert.deepEqual(card.lines, [
    'Plan act: open the menu',
    '1 step · budget 8 s',
    '1. movePointer · move the pointer to (100, 200)',
  ])
})

test('an English step line reads naturally for anchored targets', () => {
  const plan = planOf([{ op: 'movePointer', at: { window: { title: 'demo' }, point: [0.25, 0.75] } }])
  assert.equal(describeStep(plan.steps[0]!, 0, 'en'),
    '1. movePointer · move the pointer inside the window titled "demo" at (0.25, 0.75)')
})
