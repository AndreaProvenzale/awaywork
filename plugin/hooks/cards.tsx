import type { ClientElements, ClientModule, RenderNode } from 'claude-code'

export type Card = { id: string; ref: string; word: string; title: string[]; color?: string }
/** `n` cards a page, each `w` wide, as the hooks laid them out. */
type Props = { cards: Card[]; at: number; n: number; w: number }

export const CARD_ROWS = 5

/** One card: the ref, cut first, and the word on line 1, the title under them; the hooks draw it too, the ref a Button. */
export const card = (
  { Box, Text }: Pick<ClientElements, 'Box' | 'Text'>,
  c: Card,
  on: boolean,
  w: number,
  ref: RenderNode = (
    <Text bold={on} wrap="truncate-end">
      {c.ref}
    </Text>
  ),
) => (
  <Box
    key={c.id}
    width={w}
    height={CARD_ROWS}
    flexDirection="column"
    paddingX={1}
    borderStyle={on ? 'bold' : 'round'}
    borderColor={on ? 'suggestion' : 'inactive'}
  >
    <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
      {ref}
      <Box flexShrink={0}>
        <Text color={c.color} dimColor={!c.color}>
          {c.word}
        </Text>
      </Box>
    </Box>
    {c.title.map((line) => (
      <Text dimColor={!on} wrap="truncate-end">
        {line}
      </Text>
    ))}
  </Box>
)

// One strip per pane: the listeners, set once, read the latest drawing through this.
let live = { cards: [] as Card[], at: 0, start: 0, from: 0, w: 1 }

/** A move of ours the hooks haven't drawn yet, and the props' `at` it started from. */
let moved: { at: number; from: number } | undefined

/** The cards of one tab, a page at a time: ←/→ and clicks move here at once, keys go to the hooks. */
const Cards: ClientModule<Props, true> = (p, s) => {
  const { Box } = s.elements
  if (moved && moved.from !== p.at) moved = undefined
  const at = moved?.at ?? p.at
  const start = Math.floor(at / p.n) * p.n
  live = { cards: p.cards, at, start, from: p.at, w: p.w }

  if (!s.state) {
    const go = (to: number) => {
      const i = Math.max(0, Math.min(live.cards.length - 1, to))
      const c = live.cards[i]
      if (i === live.at || !c) return
      moved = { at: i, from: live.from }
      s.setState(true)
      s.post({ select: c.id })
    }
    s.onKey((k) => {
      if (k.key === 'left' || (k.key === 'tab' && k.shift)) go(live.at - 1)
      else if (k.key === 'right' || k.key === 'tab') go(live.at + 1)
      else s.post({ key: k.key })
    })
    s.onPointer((e) => {
      if (e.type === 'down' && e.x % (live.w + 1) < live.w)
        go(live.start + Math.floor(e.x / (live.w + 1)))
    })
    s.setState(true)
  }

  return (
    <Box flexDirection="row" columnGap={1}>
      {p.cards.slice(start, start + p.n).map((c, i) => card(s.elements, c, start + i === at, p.w))}
    </Box>
  )
}

export default Cards
