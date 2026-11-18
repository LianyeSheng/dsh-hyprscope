/** Render language for the human-facing consent card and overlay. */
import { ErrorCode, HyprscopeError } from './errors.ts'

/** Languages the renderers understand. */
export type RenderLanguage = 'zh' | 'en'

/**
 * Parse one language name.
 * @param value Raw flag or environment value.
 * @returns The language, or null when the value names no supported language.
 */
export function parseLanguage(value: string | undefined): RenderLanguage | null {
  if (value === undefined) return null
  const normalized = value.trim().toLowerCase()
  if (normalized === '') return null
  if (normalized.startsWith('zh')) return 'zh'
  if (normalized.startsWith('en')) return 'en'
  return null
}

/**
 * Resolve the language used for one call: `--lang`, then `HYPRSCOPE_LANG`, then Chinese.
 * @param explicit Value of the caller's `--lang`, when it passed one.
 * @returns Language accepted by the card builders and the overlay.
 * @throws HyprscopeError when the explicit value names no supported language.
 */
export function resolveLanguage(explicit?: string): RenderLanguage {
  if (explicit !== undefined) {
    const parsed = parseLanguage(explicit)
    if (parsed === null) {
      throw new HyprscopeError(ErrorCode.USAGE, `--lang expects zh or en, not "${explicit}"`)
    }
    return parsed
  }
  return parseLanguage(process.env.HYPRSCOPE_LANG) ?? 'zh'
}

/**
 * Pick the phrasing for one language.
 * @param lang Render language.
 * @param zh Chinese text.
 * @param en English text.
 * @returns The text for that language.
 */
export function tr(lang: RenderLanguage, zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}
