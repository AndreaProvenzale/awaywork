import type { z } from 'zod'
import type { ConfigShape } from '#config/schema'
import { providers } from '#providers/index'

export type Path = (string | number)[]
export type Issue = (path: Path, message: string) => void

/** Reports a custom issue under `at`. */
export const issueAt =
  (ctx: z.RefinementCtx, at: Path = []): Issue =>
  (path, message) =>
    ctx.addIssue({ code: 'custom', path: [...at, ...path], message })

export const providerIds = (cfg: ConfigShape) => cfg.providers.flatMap(Object.keys)

export const commandIds = (cfg: ConfigShape) =>
  providerIds(cfg).filter((id) => !Object.hasOwn(providers, id))
