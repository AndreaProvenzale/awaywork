import { realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Command } from 'commander'
import { configPath, loadConfig } from '../config/load.js'
import { stateDir } from '../config/paths.js'
import { clock } from '../core/window.js'
import { exec } from '../forge/gh.js'
import { defaultScheduler, schedulers } from '../scheduler/index.js'
import { reportConfigError } from './config.js'

export function scheduleCommand(program: Command): void {
  const schedule = program
    .command('schedule')
    .description('run night-shift every night on this machine')
  const all = schedulers(homedir(), exec)

  schedule
    .command('install')
    .description('start `nightshift run` at night.start; it starts no unit after night.end')
    .option(
      '--with <scheduler>',
      `${Object.keys(all).join(', ')} (default: launchd on macOS, else systemd if it runs, else cron)`,
    )
    .action(async (opts: { with?: string }) => {
      const scheduler = all[opts.with ?? defaultScheduler()]
      if (!scheduler) {
        console.error(`unknown scheduler "${opts.with}"; use ${Object.keys(all).join(', ')}`)
        process.exitCode = 1
        return
      }
      try {
        const path = resolve(configPath(program.opts().config))
        const { night } = await loadConfig(path)
        const [hour, minute] = clock(night.start)
        const bin = realpathSync(process.argv[1] ?? '')
        const log = join(stateDir, 'schedule.log')
        await mkdir(stateDir, { recursive: true })
        for (const other of Object.values(all))
          if (other !== scheduler && (await other.remove()))
            console.log(`Removed the ${other.id} job`)
        const where = await scheduler.install({
          command: [process.execPath, bin, 'run', '--scheduled', '--config', path],
          hour,
          minute,
          path: process.env.PATH ?? '',
          log,
        })
        console.log(
          `Scheduled with ${scheduler.id} at ${night.start}, window until ${night.end}: ${where}`,
        )
        console.log(`Log: ${log}. The job keeps this shell's PATH; secrets come from the env file.`)
        if (scheduler.id === 'systemd')
          console.log(
            'User timers run only while you are logged in; `loginctl enable-linger` lifts that.',
          )
      } catch (e) {
        reportConfigError(e)
      }
    })

  schedule
    .command('remove')
    .description('remove the nightly job')
    .action(async () => {
      const removed = []
      for (const scheduler of Object.values(all))
        if (await scheduler.remove()) removed.push(scheduler.id)
      console.log(
        removed.length ? `Removed the ${removed.join(', ')} job` : 'No nightly job installed',
      )
    })

  schedule
    .command('status')
    .description('show the installed nightly job')
    .action(async () => {
      let found = false
      for (const scheduler of Object.values(all)) {
        const job = await scheduler.read()
        if (!job) continue
        found = true
        const at = [job.hour, job.minute].map((n) => String(n).padStart(2, '0')).join(':')
        const flag = job.command.indexOf('--config')
        const config = flag >= 0 ? job.command[flag + 1] : 'the default'
        console.log(`Scheduled with ${scheduler.id} at ${at}`)
        console.log(`Config: ${config}`)
        console.log(`Log: ${job.log}`)
      }
      if (!found) console.log('No nightly job installed')
    })
}
