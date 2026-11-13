/** `3 units`, `1 unit`. */
export const counted = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`

/** A thrown value's message, whatever was thrown. */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
