/**
 * Hashing the generated desktop configuration.
 *
 * Kept apart from the generator so the read-only entry can hash a desktop's
 * configuration without importing the control-side bind module.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One agent Lua snippet embedded in the generated file. */
export interface DesktopSnippet {
  name: string
  content: string
}

/**
 * Read every regular `*.lua` file in basename order.
 * @param agentDir Snippet directory.
 * @returns Snippets; a missing directory holds none.
 */
export async function readDesktopSnippets(agentDir: string): Promise<DesktopSnippet[]> {
  let names: string[]
  try {
    names = (await readdir(agentDir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.lua'))
      .map(entry => entry.name)
      .sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const snippets: DesktopSnippet[] = []
  for (const name of names) snippets.push({ name, content: await readFile(join(agentDir, name), 'utf8') })
  return snippets
}

/**
 * Hash the generated text and the snippet files in hash order.
 * @param text Generated file content, or null when it does not exist.
 * @param snippets Agent snippets in basename order.
 * @returns Lower-case SHA-256 hex digest.
 */
export function digestDesktopConfig(text: string | null, snippets: readonly DesktopSnippet[]): string {
  const hash = createHash('sha256')
  if (text !== null) hash.update(`hyprland.lua\0${text}\0`)
  for (const snippet of snippets) hash.update(`agent/${snippet.name}\0${snippet.content}\0`)
  return hash.digest('hex')
}

/**
 * Hash the generated configuration and every agent snippet on disk.
 *
 * A missing generated file contributes no bytes: an empty directory hashes like
 * the empty string, while a snippet still changes the digest.
 * @param configDir `$XDG_STATE_HOME/hyprscope/desktop/config`.
 * @returns Lower-case SHA-256 hex digest.
 */
export async function hashDesktopConfig(configDir: string): Promise<string> {
  const hyprDir = join(configDir, 'hypr')
  let text: string | null = null
  try {
    text = await readFile(join(hyprDir, 'hyprland.lua'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return digestDesktopConfig(text, await readDesktopSnippets(join(hyprDir, 'agent')))
}
