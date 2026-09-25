export function notImplemented(what: string, milestone: string): never {
  throw new Error(`${what} is not implemented yet (${milestone})`)
}
