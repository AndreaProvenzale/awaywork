import type { Deliver } from '../core/types.js'

/** Context, output and prompt live here inside the clone; git ignores it. */
export const WORK_DIR = '.away'
export const outputFile: Record<Deliver, string> = {
  draft_pr: 'pr.md',
  pr: 'pr.md',
  report: 'report.md',
  push: 'pr.md',
  pending_review: 'report.md',
  plan: 'report.md',
}

/** Whether a unit only reports: a `pending_review` one's report is left as a review, a `plan` one's posted with its plan. */
export const reportsOnly = (deliver: Deliver) =>
  deliver === 'report' || deliver === 'pending_review' || deliver === 'plan'
