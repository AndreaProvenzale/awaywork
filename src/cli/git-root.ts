import { type Exec, exec } from '../forge/gh.js'

export const gitRoot = (run: Exec = exec) =>
  run('git', ['rev-parse', '--show-toplevel']).catch(() => undefined)
