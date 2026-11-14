import type { CheckResult } from '#core/types'

/** A commit's checks, for a GraphQL `Commit`: check runs and commit statuses. */
export const checkContexts = `statusCheckRollup { contexts(first: 100) { nodes {
  __typename
  ... on CheckRun { name status conclusion detailsUrl }
  ... on StatusContext { context state targetUrl description }
} } }`

export type Check =
  | {
      __typename: 'CheckRun'
      name: string
      status: string
      conclusion: string | null
      detailsUrl: string
    }
  | {
      __typename: 'StatusContext'
      context: string
      state: string
      targetUrl: string | null
      description: string | null
    }

/** A check's name, state and link; a check run passes as GitHub's required checks do: success, neutral or skipped. */
export function checkResult(c: Check): [string, CheckResult] {
  if (c.__typename === 'StatusContext') {
    const pending = ['PENDING', 'EXPECTED'].includes(c.state)
    const state = c.state === 'SUCCESS' ? 'passed' : pending ? 'pending' : 'failing'
    return [c.context, { state, ...(c.targetUrl && { url: c.targetUrl }) }]
  }
  const url = c.detailsUrl && { url: c.detailsUrl }
  if (c.status !== 'COMPLETED') return [c.name, { state: 'pending', ...url }]
  const passed = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion ?? '')
  return [c.name, { state: passed ? 'passed' : 'failing', ...url }]
}
