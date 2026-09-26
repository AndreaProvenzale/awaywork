import { readFileSync } from 'node:fs'

export const asanaFixture = (name: string) =>
  readFileSync(new URL(`../fixtures/asana/${name}`, import.meta.url), 'utf8')

type Reply = string | { status: number; body: string; headers?: Record<string, string> }

/** Replays recorded responses: the first route whose pattern matches the URL answers. */
export function recordedFetch(
  routes: [RegExp, Reply][],
): typeof fetch & { calls: { url: string; headers: Record<string, string> }[] } {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const http = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
    const route = routes.find(([pattern]) => pattern.test(url))
    if (!route) throw new Error(`no recorded response for: ${url.slice(0, 120)}`)
    const reply = typeof route[1] === 'string' ? { status: 200, body: route[1] } : route[1]
    return new Response(reply.body, { status: reply.status, headers: reply.headers })
  }
  return Object.assign(http as typeof fetch, { calls })
}

export const asanaRoutes = (): [RegExp, Reply][] => [
  [/\/tasks\?.*offset=eyJwYWdlIjoyfQ/, asanaFixture('tasks-2.json')],
  [/\/tasks\?/, asanaFixture('tasks-1.json')],
  [/\/tasks\/1201\/stories\?/, asanaFixture('stories-1201.json')],
  [/\/tasks\/\d+\/stories\?/, asanaFixture('stories-empty.json')],
]
