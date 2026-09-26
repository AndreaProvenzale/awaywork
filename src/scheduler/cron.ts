import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec } from '../forge/gh.js'
import type { Schedule, Scheduler } from './index.js'

const TAG = '# night-shift'

/** One tagged line in the user's crontab; cron skips a run missed while the machine sleeps. */
export function cron(run: Exec): Scheduler {
  const read = () => run('crontab', ['-l']).catch(() => '')
  const write = async (lines: string[]) => {
    const dir = await mkdtemp(join(tmpdir(), 'nightshift-'))
    try {
      await writeFile(join(dir, 'crontab'), lines.map((l) => `${l}\n`).join(''))
      await run('crontab', [join(dir, 'crontab')])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  const others = (text: string) => text.split('\n').filter((l) => l && !l.endsWith(TAG))
  return {
    id: 'cron',
    async install(s) {
      await write([...others(await read()), cronLine(s)])
      return 'crontab'
    },
    async remove() {
      const text = await read()
      const kept = others(text)
      if (kept.length === text.split('\n').filter(Boolean).length) return false
      await write(kept)
      return true
    },
  }
}

export function cronLine(s: Schedule): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`.replace(/%/g, '\\%')
  const command = `PATH=${q(s.path)} ${s.command.map(q).join(' ')} >> ${q(s.log)} 2>&1`
  return `${s.minute} ${s.hour} * * * ${command} ${TAG}`
}
