/** The render language is chosen per call: flag, then environment, then Chinese. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseLanguage, resolveLanguage, tr } from '../src/i18n.ts'

test('parseLanguage accepts locale-like names and rejects the rest', () => {
  assert.equal(parseLanguage(undefined), null)
  assert.equal(parseLanguage(''), null)
  assert.equal(parseLanguage('zh'), 'zh')
  assert.equal(parseLanguage('zh_CN.UTF-8'), 'zh')
  assert.equal(parseLanguage('EN'), 'en')
  assert.equal(parseLanguage('en_US.UTF-8'), 'en')
  assert.equal(parseLanguage('fr'), null)
})

test('resolveLanguage prefers the flag, then HYPRSCOPE_LANG, then Chinese', () => {
  const previous = process.env.HYPRSCOPE_LANG
  try {
    delete process.env.HYPRSCOPE_LANG
    assert.equal(resolveLanguage(), 'zh')
    assert.equal(resolveLanguage('en'), 'en')
    process.env.HYPRSCOPE_LANG = 'en'
    assert.equal(resolveLanguage(), 'en')
    assert.equal(resolveLanguage('zh'), 'zh')
    process.env.HYPRSCOPE_LANG = 'nonsense'
    assert.equal(resolveLanguage(), 'zh')
  } finally {
    if (previous === undefined) delete process.env.HYPRSCOPE_LANG
    else process.env.HYPRSCOPE_LANG = previous
  }
})

test('an unsupported --lang value is a usage failure', () => {
  assert.throws(() => resolveLanguage('fr'), (error) => {
    assert.equal((error as { code?: string }).code, 'USAGE')
    return true
  })
})

test('tr picks the requested phrasing', () => {
  assert.equal(tr('zh', '允许', 'Allow'), '允许')
  assert.equal(tr('en', '允许', 'Allow'), 'Allow')
})
