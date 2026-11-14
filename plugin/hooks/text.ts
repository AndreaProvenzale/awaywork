export const lines = (...text: (string | null | undefined)[]) =>
  text.filter((t): t is string => !!t)

const pad = (n: number) => String(n).padStart(2, '0')

export function when(iso: string, now: number) {
  const t = new Date(iso)
  const time = `${pad(t.getHours())}:${pad(t.getMinutes())}`
  if (t.toDateString() === new Date(now).toDateString()) return time
  return `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${time}`
}

const clip = (text: string, room: number) =>
  text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`

export const counted = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

const MIN_CARD = 24

/** Cards a page and their width: as many as fit MIN_CARD wide, stretched to fill the row. */
export function cardsFit(columns: number) {
  const n = Math.max(1, Math.floor((columns + 1) / (MIN_CARD + 1)))
  return { n, w: Math.floor((columns + 1) / n) - 1 }
}

/** A title in at most two lines, the second cut with an ellipsis. */
export function twoLines(title: string, width: number) {
  const [first = '', ...rest] = wrap(title, width)
  return rest.length ? [first, clip(rest.join(' '), width)] : [first]
}

export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      if (line && line.length + 1 + word.length > width) {
        out.push(line)
        line = ''
      }
      line = line ? `${line} ${word}` : word
      while (line.length > width) {
        out.push(line.slice(0, width))
        line = line.slice(width)
      }
    }
    out.push(line)
  }
  return out
}

/** Rows a wrapping row of `parts` takes at `width`, `gap` apart. */
export function rowsOf(parts: string[], width: number, gap = 2) {
  let rows = 1
  let used = 0
  for (const p of parts) {
    if (used && used + gap + p.length > width) {
      rows++
      used = 0
    }
    used += (used ? gap : 0) + p.length
  }
  return rows
}
