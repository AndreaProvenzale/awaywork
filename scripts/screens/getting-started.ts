import { type Loading, loading, loadingView, progress, tick } from '#cli/tui/triage'
import { brandHeader } from '#format/terminal'
import type { Step } from '#plan/probe'

function planLoading(): string {
  const steps: Step[] = [
    { name: 'github', state: 'done', detail: '5 items' },
    { name: 'tracker', state: 'done', detail: '2 items' },
    { name: 'linking PRs', state: 'done', detail: '2/2' },
    { name: 'claude quota', state: 'running' },
  ]
  let l: Loading = steps.reduce(progress, loading(brandHeader(true), 'Planning the next run'))
  for (let i = 0; i < 3; i++) l = tick(l)
  return loadingView(l, 80, 10).join('\n').trimEnd()
}

export default { 'plan-loading': planLoading() }
