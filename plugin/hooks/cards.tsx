import type { ClientModule } from 'claude-code'

type Card = { id: string; ref: string; word: string; title: string[]; color?: string }
/** `n` cards a page, each `w` wide, as the hooks laid them out. */
type Props = { cards: Card[]; at: number; n: number; w: number }
/** `at` is a move of ours the hooks haven't drawn yet; `from` the props' `at` it started from. */
type State = { at: number; from: number }

// One strip per pane: the listeners, set once, read the latest drawing through this.
let live = { cards: [] as Card[], at: 0, start: 0, from: 0, w: 1 }

/** The cards of one tab, a page at a time: ←/→ and clicks move here at once, keys go to the hooks. */
const Cards: ClientModule<Props, State> = (p, s) => {
  const { Box, Text } = s.elements
  const at = s.state && s.state.from === p.at ? s.state.at : p.at
  const start = Math.floor(at / p.n) * p.n
  live = { cards: p.cards, at, start, from: p.at, w: p.w }

  if (!s.state) {
    const go = (to: number) => {
      const i = Math.max(0, Math.min(live.cards.length - 1, to))
      const card = live.cards[i]
      if (i === live.at || !card) return
      s.setState({ at: i, from: live.from })
      s.post({ select: card.id })
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
    s.setState({ at, from: p.at })
  }

  return (
    <Box flexDirection="row" columnGap={1}>
      {p.cards.slice(start, start + p.n).map((c, i) => {
        const on = start + i === at
        return (
          <Box
            width={p.w}
            height={5}
            flexDirection="column"
            paddingX={1}
            borderStyle={on ? 'bold' : 'round'}
            borderColor={on ? 'suggestion' : 'inactive'}
          >
            <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
              <Text bold={on} wrap="truncate-end">
                {c.ref}
              </Text>
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
      })}
    </Box>
  )
}

export default Cards
