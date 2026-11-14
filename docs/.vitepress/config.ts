import { readFileSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type DefaultTheme, defineConfig } from 'vitepress'

const repo = 'https://github.com/AndreaProvenzale/awaywork'
const screens = new URL('screens/', import.meta.url)
const site = 'https://andreaprovenzale.github.io/awaywork/'
const description = 'A harness that runs your coding agents on your real tasks, under rules you set'

const sidebar: DefaultTheme.SidebarItem[] = [
  {
    text: 'Start',
    collapsed: false,
    items: [
      { text: 'Getting started', link: '/guide/getting-started' },
      { text: 'How it works', link: '/guide/how-it-works' },
      { text: '/away in Claude Code', link: '/guide/away' },
      { text: 'With an AI agent', link: '/guide/agents' },
      { text: 'Suggested rules', link: '/guide/suggest' },
    ],
  },
  {
    text: 'Day to day',
    collapsed: true,
    items: [
      { text: 'Plan, run, report', link: '/guide/running' },
      { text: 'Where results go', link: '/guide/results' },
      { text: 'Skills', link: '/guide/skills' },
    ],
  },
  {
    text: 'Configure',
    collapsed: true,
    items: [
      { text: 'The config file', link: '/guide/config/' },
      { text: 'Queue rules', link: '/guide/config/queue-rules' },
      { text: 'Matching items', link: '/guide/config/where' },
      { text: 'Chains', link: '/guide/config/chains' },
      { text: 'Providers and budget', link: '/guide/config/providers' },
      { text: 'Sources', link: '/guide/config/sources' },
      { text: 'Custom sources', link: '/guide/config/custom-sources' },
      { text: 'Repos and branches', link: '/guide/config/repos' },
      { text: 'MCP servers', link: '/guide/config/mcp' },
    ],
  },
  {
    text: 'Workflows',
    collapsed: true,
    items: [
      { text: 'Overview', link: '/guide/workflows/' },
      { text: 'Questions and continue', link: '/guide/workflows/questions' },
      { text: 'Gates', link: '/guide/workflows/gates' },
      { text: 'Plans', link: '/guide/workflows/plans' },
      { text: 'Tasks', link: '/guide/workflows/tasks' },
      { text: 'Posts that wait and threads', link: '/guide/workflows/posts' },
      { text: 'Store', link: '/guide/workflows/store' },
      { text: 'Proving a change', link: '/guide/workflows/proving' },
    ],
  },
  {
    text: 'Run it',
    collapsed: true,
    items: [
      { text: 'Where to run', link: '/guide/scheduling/' },
      { text: 'On your machine', link: '/guide/scheduling/machine' },
      { text: 'In GitHub Actions', link: '/guide/scheduling/actions' },
      { text: 'In a container', link: '/guide/scheduling/container' },
      { text: 'From your laptop', link: '/guide/scheduling/laptop' },
    ],
  },
  {
    text: 'Safety',
    collapsed: true,
    items: [
      { text: 'Overview', link: '/guide/safety/' },
      { text: 'Isolation', link: '/guide/safety/isolation' },
      { text: 'What awaywork publishes', link: '/guide/safety/publishes' },
    ],
  },
  {
    text: 'Examples',
    collapsed: true,
    items: [
      { text: 'A full config', link: '/examples/full-config' },
      { text: 'Morning report on your phone', link: '/examples/ntfy-report' },
      { text: 'A Notion page per plan', link: '/examples/notion-plans' },
      { text: 'Slack when a review is ready', link: '/examples/slack-reviews' },
      { text: "Acting on a skill's output", link: '/examples/skill-output' },
      { text: 'Chores', link: '/examples/chores' },
      { text: 'Sentry errors', link: '/examples/sentry' },
      { text: 'Markdown files as threads', link: '/examples/markdown-threads' },
    ],
  },
  {
    text: 'Reference',
    collapsed: true,
    items: [
      { text: 'CLI', link: '/reference/cli' },
      { text: 'Config', link: '/reference/config' },
    ],
  },
  {
    text: 'Extend',
    collapsed: true,
    items: [
      { text: 'Adding a provider', link: '/extend/providers' },
      { text: 'Adding a source', link: '/extend/sources' },
    ],
  },
  {
    text: 'Research',
    collapsed: true,
    items: [
      { text: 'Providers', link: '/providers' },
      { text: 'Sources', link: '/sources' },
    ],
  },
]

const nav: DefaultTheme.NavItem[] = [
  { text: 'Guide', link: '/guide/getting-started' },
  { text: 'Examples', link: '/examples/full-config' },
  { text: 'Reference', link: '/reference/cli' },
]

export default defineConfig({
  base: '/awaywork/',
  title: 'awaywork',
  description,
  cleanUrls: true,
  lastUpdated: false,
  markdown: {
    config(md) {
      const fence = md.renderer.rules.fence
      md.renderer.rules.fence = (tokens, index, ...rest) => {
        const token = tokens[index]
        if (token?.info.trim() === 'mermaid')
          return `<Mermaid code="${encodeURIComponent(token.content)}" />`
        // A `<lang> <name>` block is generated output; a `text` one shows in the colors `pnpm docs:gen` wrote.
        const [, lang, screen] = token?.info.match(/^(\w+) (\S+)$/) ?? []
        if (token && lang && screen) {
          token.info = lang === 'text' ? 'ansi' : lang
          if (lang === 'text')
            token.content = readFileSync(new URL(`${screen}.ansi`, screens), 'utf8')
        }
        return fence?.(tokens, index, ...rest) ?? ''
      }
    },
  },
  head: [
    ['link', { rel: 'icon', href: '/awaywork/brand/favicon.ico', sizes: '32x32' }],
    ['link', { rel: 'icon', href: '/awaywork/brand/favicon.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'apple-touch-icon', href: '/awaywork/brand/apple-touch-icon.png' }],
    ['meta', { property: 'og:image', content: `${site}brand/og.png` }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],
  themeConfig: {
    logo: { light: '/brand/mark.svg', dark: '/brand/mark-dark.svg', alt: '' },
    nav,
    sidebar,
    search: { provider: 'local' },
    editLink: { pattern: `${repo}/edit/main/docs/:path` },
    socialLinks: [
      { icon: 'github', link: repo },
      { icon: 'npm', link: 'https://www.npmjs.com/package/awaywork' },
    ],
  },
  async buildEnd({ srcDir, outDir }) {
    const pages = await Promise.all(
      sidebar.map(async (group) => ({
        title: group.text,
        pages: await Promise.all(
          (group.items ?? []).map(async (item) => {
            const file = `${item.link?.slice(1).replace(/\/$/, '/index')}.md`
            const text = await readFile(join(srcDir, file), 'utf8')
            await mkdir(dirname(join(outDir, file)), { recursive: true })
            await copyFile(join(srcDir, file), join(outDir, file))
            return { title: item.text, url: site + file, text, summary: summary(text) }
          }),
        ),
      })),
    )
    const index = pages.map(
      (group) =>
        `## ${group.title}\n\n${group.pages.map((p) => `- [${p.title}](${p.url}): ${p.summary}`).join('\n')}`,
    )
    await writeFile(
      join(outDir, 'llms.txt'),
      `# awaywork\n\n> ${description}. An open-source CLI that pulls a developer's items from their forge and task tracker (GitHub, Asana, Linear, Jira Cloud), matches them against an ordered queue of rules, and runs the vendors' own agent CLIs (Claude Code, Codex, Cursor) on them headless with the developer's login, pacing their quota. Output is a draft PR from a new branch on GitHub or Bitbucket Cloud, a report, or a question, plan or result on the developer's own item, which can wait for their reply.\n\nEvery page is Markdown at its URL below; llms-full.txt has them all in one file.\n\n${index.join('\n\n')}\n`,
    )
    const full = pages.flatMap((group) =>
      group.pages.map((p) => `<!-- ${p.url} -->\n\n${body(p.text)}`),
    )
    await writeFile(join(outDir, 'llms-full.txt'), `${full.join('\n\n')}\n`)
  },
})

function body(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
}

/** The frontmatter description, else the first prose paragraph. */
function summary(text: string): string {
  const described = text.match(/^---\n[\s\S]*?^description:\s*(.+)$[\s\S]*?\n---\n/m)?.[1]
  if (described) return described.replace(/^(['"])(.*)\1$/, '$2')
  const paragraph = body(text)
    .split(/\n\s*\n/)
    .find((block) => /^[A-Za-z`*[]/.test(block))
  return (paragraph ?? '').replace(/\s+/g, ' ')
}
