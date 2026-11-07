import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const script = join(import.meta.dirname, '../plugin/skills/away/scripts/folders.sh')
const token = 'FAKE-TOKEN-1234'
const slug = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, '-')
const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value))

async function session(root: string, cwd: string, id: string) {
  await mkdir(join(root, 'projects', slug(cwd)), { recursive: true })
  const first = { type: 'user', entrypoint: 'cli', sessionId: id, cwd, message: { content: token } }
  await writeFile(join(root, 'projects', slug(cwd), `${id}.jsonl`), `${JSON.stringify(first)}\n`)
}

describe('folders.sh', () => {
  it("lists each Claude folder's session folders with their MCP servers, never a server's secrets", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'awaywork-folders-')))
    const api = join(home, 'src/api')
    const notes = join(home, 'notes')
    const work = join(home, '.claude-work')
    await mkdir(api, { recursive: true })
    await mkdir(notes)
    await execa('git', ['init', '-q', api])
    await execa('git', ['-C', api, 'remote', 'add', 'origin', 'git@github.com:acme/api.git'])
    const secrets = { headers: { Authorization: `Bearer ${token}` }, env: { KEY: token } }
    await json(join(api, '.mcp.json'), {
      mcpServers: {
        tasks: { type: 'http', url: `https://tasks.acme.com/mcp?token=${token}`, ...secrets },
        local: { command: 'npx', args: ['--key', token], ...secrets },
      },
    })
    await session(join(home, '.claude'), api, 's1')
    await mkdir(join(home, '.claude/projects', slug(api), 'memory'))
    await writeFile(join(home, '.claude/projects', slug(api), 'memory/MEMORY.md'), token)
    await writeFile(join(home, '.claude/projects', slug(api), 'memory/pnpm.md'), token)
    await json(join(home, '.claude.json'), {
      mcpServers: { sentry: { type: 'stdio', command: 'npx', args: [token], ...secrets } },
      projects: {
        [api]: {
          mcpServers: {
            asana: { type: 'http', url: `https://me:${token}@mcp.asana.com:443/sse?k=${token}` },
          },
          disabledMcpServers: ['claude.ai Slack'],
        },
      },
    })
    await session(work, notes, 's2')
    await json(join(work, '.claude.json'), {
      projects: {
        [notes]: { mcpServers: { linear: { type: 'sse', url: 'https://mcp.linear.app/sse' } } },
      },
    })
    await writeFile(join(work, 'CLAUDE.md'), token)

    const env = { HOME: home, PATH: process.env.PATH }
    const run = (args: string[], more = {}) =>
      execa('sh', [script, ...args], { env: { ...env, ...more }, extendEnv: false })
    const { stdout } = await run(['30', join(home, '.claude'), work])

    expect(stdout).toBe(
      [
        'agent\tsessions\tMB\tmemories\tclaude\tmcp\tfolder\trepo',
        `claude\t1\t0.0\t1\t~/.claude\tasana, claude.ai Slack, local, tasks\t${api}\tacme/api`,
        `claude\t1\t0.0\t0\t~/.claude-work\tlinear\t${notes}\t-`,
        '',
        'mcp servers',
        'name\tscope\ttype\thost',
        'asana\tlocal\thttp\tmcp.asana.com',
        'linear\tlocal\tsse\tmcp.linear.app',
        'local\tproject\tstdio\t-',
        'sentry\tuser\tstdio\t-',
        'tasks\tproject\thttp\ttasks.acme.com',
        '',
        'user-level files',
        join(work, 'CLAUDE.md'),
      ].join('\n'),
    )
    expect(stdout).not.toContain('FAKE')
    expect((await run(['30'], { CLAUDE_CONFIG_DIR: work })).stdout).toBe(stdout)
  })
})
