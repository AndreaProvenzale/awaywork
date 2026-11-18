/** `3 files`, `1 file`. */
export const counted = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

/** The first lines of a text and how many more it had, each line cut at a length: what a stored error may be. */
export function bounded(text: string, { lines = 5, chars = 1000 } = {}): string {
  const all = text.trimEnd().split('\n')
  const kept = all.slice(0, lines).map((l) => (l.length > chars ? `${l.slice(0, chars)}…` : l))
  return all.length > lines
    ? `${kept.join('\n')}\n(and ${all.length - lines} more)`
    : kept.join('\n')
}

/** A thrown value's message, whatever was thrown. */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
