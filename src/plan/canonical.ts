/** Canonical serialization for run artifacts and committed records. */

/**
 * Recursively sort object keys and drop `undefined` members so two equivalent
 * values serialize to the same string.
 * @param value JSON-compatible value.
 * @returns Canonical value.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(entry => canonicalize(entry))
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(record).sort()) {
    const entry = record[key]
    if (entry === undefined) continue
    sorted[key] = canonicalize(entry)
  }
  return sorted
}

/**
 * Serialize a value canonically: sorted keys, no whitespace.
 * @param value JSON-compatible value.
 * @returns Canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}
