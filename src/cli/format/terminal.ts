import { stripVTControlCharacters, styleText } from 'node:util'

/** A `Warnings` heading over warnings indented as blocks and a blank line, or nothing. */
export function warningLines(warnings: string[], styled = false): string[] {
  if (warnings.length === 0) return []
  return [
    heading('Warnings', warnings.length, styler(styled)),
    ...warnings.flatMap((w) => indent(warningBlock(w))),
    '',
  ]
}

/** A warning's lines, the later ones indented under the first. */
export function warningBlock(warning: string): string[] {
  return warning
    .split('\n')
    .filter((line) => line.trim())
    .map((line, i) => `${i ? '  ' : ''}${line.trimEnd()}`)
}

export type Style = (format: 'bold' | 'dim', text: string) => string

/** `Units 3`: a section's title and how many it holds. */
export const heading = (title: string, n: number, style: Style = (_, text) => text) =>
  style('bold', `${title} ${n}`)

export const styler =
  (styled: boolean): Style =>
  (format, text) =>
    styled ? styleText(format, text) : text

export const TITLE = 60

const segmenter = new Intl.Segmenter()

export const graphemes = (text: string) => Array.from(segmenter.segment(text), (s) => s.segment)

/** CJK, Hangul and fullwidth forms take two columns; marks and joiners none. */
const wide =
  /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u
const charColumns = (char: string) =>
  /\p{Mn}|\p{Me}|\p{Default_Ignorable_Code_Point}/u.test(char) ? 0 : wide.test(char) ? 2 : 1

/** The columns a grapheme takes: an emoji two, whatever its flag, skin tone or VS16; a joiner sequence its parts, as a terminal that doesn't join it draws them. */
export const columns = (grapheme: string): number =>
  grapheme.includes('\u200d')
    ? grapheme.split('\u200d').reduce((sum, part) => sum + columns(part), 0)
    : /\p{Emoji_Presentation}|\ufe0f/u.test(grapheme)
      ? 2
      : [...grapheme].reduce((sum, char) => sum + charColumns(char), 0)

/** The columns `text` takes in a terminal, escape codes aside. */
export const width = (text: string) =>
  graphemes(stripVTControlCharacters(text)).reduce((sum, g) => sum + columns(g), 0)

export const pad = (text: string, cols: number) =>
  text + ' '.repeat(Math.max(0, cols - width(text)))

/** `text` cut to `length` columns with an ellipsis, never inside a grapheme. */
export function clip(text: string, length: number): string {
  if (width(text) <= length) return text
  let out = ''
  let room = length - 1
  for (const g of graphemes(text)) {
    room -= columns(g)
    if (room < 0) break
    out += g
  }
  return `${out.trimEnd()}…`
}

export function hintLines(style: Style, hints: [string, string][]): string[] {
  return table(hints).map((line) => style('dim', line))
}

export function indent(lines: string[]): string[] {
  return lines.map((l) => `  ${l}`)
}

export const CELL = 60

/** A cell's first line, clipped: `--unit` has the rest. */
export function brief(text: string, clipAt = CELL): string {
  const [first = '', ...rest] = text.split('\n')
  return clip(rest.length > 0 ? `${first.trimEnd()}…` : first, clipAt)
}

export function table(
  rows: string[][],
  style: (cell: string, r: number, c: number) => string = (cell) => cell,
): string[] {
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map((r) => width(r[c] ?? '')))) ?? []
  return rows.map((row, r) =>
    row
      .map((cell, c) => style(pad(cell, widths[c] ?? 0), r, c))
      .join('  ')
      .trimEnd(),
  )
}

export type Status = 'ok' | 'warn' | 'FAIL'

const markers = { ok: ['✔', 'green'], warn: ['⚠', 'yellow'], FAIL: ['✖', 'red'] } as const

/** A colored glyph for a terminal, the plain word everywhere else. */
export function statusMarker(status: Status, color: boolean): string {
  if (!color) return status.padEnd(4)
  const [glyph, style] = markers[status]
  return styleText(style, glyph, { validateStream: false })
}

const amber = (text: string) => `\u001b[38;2;247;178;64m${text}\u001b[39m`

/** The logo as a line: a crescent with an amber prompt in it, then the tagline. */
export function brandHeader(color: boolean): string {
  const tagline = "You're away, your agents work"
  if (!color) return `☾ >_ awaywork  ${tagline}`
  const style = (format: 'bold' | 'dim', text: string) =>
    styleText(format, text, { validateStream: false })
  return `☾ ${style('bold', amber('>_'))} ${style('bold', 'awaywork')}  ${style('dim', tagline)}`
}
