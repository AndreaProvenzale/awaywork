/** The secret a header value names: `${NAME}`, or `Bearer ${NAME}` for Authorization; undefined for any other shape. */
export function headerSecret(
  header: string,
  value: string,
): { name: string; bearer: boolean } | undefined {
  const [, bearer, name] = value.match(/^(Bearer )?\$\{(\w+)\}$/) ?? []
  if (!name || (bearer && header.toLowerCase() !== 'authorization')) return
  return { name, bearer: !!bearer }
}
