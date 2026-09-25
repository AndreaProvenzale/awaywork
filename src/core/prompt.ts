export interface PromptParts {
  harness: string
  skill: string
  instructions: string[]
  repo: { setup?: string; test?: string; instructions?: string }
  inRepo?: string
  rule: string[]
}

/** The worker prompt in its fixed order: harness, main skill, global, repo, in-repo, then rule instructions. */
export function assemblePrompt(p: PromptParts): string {
  const commands = [
    p.repo.setup && `Setup: \`${p.repo.setup}\``,
    p.repo.test && `Test: \`${p.repo.test}\``,
  ].filter(Boolean)
  return [
    p.harness,
    p.skill,
    ...p.instructions,
    commands.join('\n'),
    p.repo.instructions,
    p.inRepo,
    ...p.rule,
  ]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join('\n\n---\n\n')
}
