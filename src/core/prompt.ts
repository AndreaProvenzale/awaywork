export interface PromptParts {
  harness: string
  skill: string
  instructions: string[]
  repo: {
    setup?: string
    setupSkipped?: boolean
    offline?: boolean
    test?: string
    instructions?: string
  }
  inRepo?: string
  rule: string[]
}

/** The worker prompt in its fixed order: harness, main skill, global, repo, in-repo, then rule instructions. */
export function assemblePrompt(p: PromptParts): string {
  const commands = [
    p.repo.setup &&
      (p.repo.setupSkipped
        ? `Setup, not run because this PR's author isn't trusted: \`${p.repo.setup}\`. Don't run it or install dependencies.`
        : `Setup, already run: \`${p.repo.setup}\``),
    p.repo.offline &&
      "No network: your commands can't reach it, so don't install dependencies or download anything.",
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
