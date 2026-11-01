import type { ClientModule } from 'claude-code'

type Card = { id: string; ref: string; word: string; color?: string }
type Props = { cards: Card[]; at: number; width: number }
/** `at` is a move of ours the hooks haven't drawn yet; `from` the props' `at` it started from. */
type State = { at: number; from: number }

const CARD = 18

// One strip per pane: the listeners, set once, read the latest drawing through this.
let live = { cards: [] as Card[], at: 0, start: 0, from: 0 }

/** The cards of one tab, a page at a time: ←/→ and clicks move here at once, keys go to the hooks. */
const Cards: ClientModule<Props, State> = (p, s) => {
  const { Box, Text } = s.elements
  const n = Math.max(1, Math.floor((p.width + 1) / (CARD + 1)))
  const at = s.state && s.state.from === p.at ? s.state.at : p.at
  const start = Math.floor(at / n) * n
  live = { cards: p.cards, at, start, from: p.at }

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
      if (e.type === 'down' && e.x % (CARD + 1) < CARD)
        go(live.start + Math.floor(e.x / (CARD + 1)))
    })
    s.setState({ at, from: p.at })
  }

  return (
    <Box flexDirection="row" columnGap={1}>
      {p.cards.slice(start, start + n).map((c, i) => {
        const on = start + i === at
        return (
          <Box
            width={CARD}
            height={4}
            flexDirection="column"
            paddingX={1}
            borderStyle={on ? 'bold' : 'round'}
            borderColor={on ? 'suggestion' : undefined}
            borderDimColor={!on}
          >
            <Text bold={on} wrap="truncate-end">
              {c.ref}
            </Text>
            <Text color={c.color} dimColor={!c.color} wrap="truncate-end">
              {c.word}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

export default Cards
