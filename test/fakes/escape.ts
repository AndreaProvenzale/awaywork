import { readFile } from 'node:fs/promises'

/** A shell command that starts `sleep 30` outside its process group, holding its output, and writes its pid to `pidFile`. */
export function escaping(pidFile: string): string {
  const spawn = `const c = require('node:child_process').spawn('sleep', ['30'], { detached: true, stdio: 'inherit' }); require('node:fs').writeFileSync('${pidFile}', String(c.pid)); c.unref()`
  return `'${process.execPath}' -e "${spawn}"`
}

/** The escaped process's pid, once `escaping` has written it. */
export async function escaped(pidFile: string): Promise<number> {
  for (;;) {
    const pid = await readFile(pidFile, 'utf8').catch(() => '')
    if (pid) return Number(pid)
    await new Promise((ok) => setTimeout(ok, 20))
  }
}
