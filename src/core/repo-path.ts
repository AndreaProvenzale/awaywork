import { z } from 'zod'

/** A repo path of two or more segments: `owner/name`, or `group/sub/project` on forges that nest. */
export const repoPath = z.string().regex(/^[^/\s]+(\/[^/\s]+)+$/, 'expected owner/name')
