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

/** How long since, as `40m`, `5h` or `5d`. */
export function ageSince(since: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000))
  if (minutes < 60) return `${minutes}m`
  return minutes < 24 * 60 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`
}

/** `2026-10-09 20:11:02` in local time; sv-SE is the locale that formats so. */
export const localTime = (d: Date) => d.toLocaleString('sv-SE')
