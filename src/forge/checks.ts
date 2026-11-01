import type { CheckState } from '../core/types.js'

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

/** A check's name and state; a check run passes as GitHub's required checks do: success, neutral or skipped. */
export function checkResult(c: Check): [string, CheckState] {
  if (c.__typename === 'StatusContext') {
    const pending = ['PENDING', 'EXPECTED'].includes(c.state)
    return [c.context, c.state === 'SUCCESS' ? 'passed' : pending ? 'pending' : 'failing']
  }
  if (c.status !== 'COMPLETED') return [c.name, 'pending']
  const passed = ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion ?? '')
  return [c.name, passed ? 'passed' : 'failing']
}
