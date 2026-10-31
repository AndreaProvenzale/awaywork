import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type DefaultTheme, defineConfig } from 'vitepress'

const repo = 'https://github.com/AndreaProvenzale/awaywork'
const site = 'https://andreaprovenzale.github.io/awaywork/'
const description = 'Schedule headless coding agents to spend idle subscription quota'

const sidebar: DefaultTheme.SidebarItem[] = [
  {
    text: 'Guide',
    items: [
      { text: 'Getting started', link: '/guide/getting-started' },
      { text: 'How it works', link: '/guide/how-it-works' },
      { text: 'Configuration', link: '/guide/configuration' },
      { text: 'Chains', link: '/guide/chains' },
      { text: 'Where results go', link: '/guide/results' },
      { text: 'Custom sources', link: '/guide/custom-sources' },
      { text: 'Skills', link: '/guide/skills' },
      { text: 'Scheduling', link: '/guide/scheduling' },
      { text: 'Safety', link: '/guide/safety' },
      { text: 'For AI agents', link: '/guide/agents' },
      { text: 'Suggested rules', link: '/guide/suggest' },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'CLI', link: '/reference/cli' },
      { text: 'Config', link: '/reference/config' },
    ],
  },
  {
    text: 'Extend',
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

export default defineConfig({
  base: '/awaywork/',
  title: 'awaywork',
  description,
  cleanUrls: true,
  lastUpdated: false,
  head: [
    ['link', { rel: 'icon', href: '/awaywork/brand/favicon.ico', sizes: '32x32' }],
    ['link', { rel: 'icon', href: '/awaywork/brand/favicon.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'apple-touch-icon', href: '/awaywork/brand/apple-touch-icon.png' }],
    ['meta', { property: 'og:image', content: `${site}brand/og.png` }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
  ],
  themeConfig: {
    logo: { light: '/brand/mark.svg', dark: '/brand/mark-dark.svg', alt: '' },
    nav: sidebar.map((group) => ({ text: group.text ?? '', link: group.items?.[0]?.link ?? '/' })),
    sidebar,
    search: { provider: 'local' },
    editLink: { pattern: `${repo}/edit/main/docs/:path` },
    socialLinks: [{ icon: 'github', link: repo }],
  },
  async buildEnd({ srcDir, outDir }) {
    const pages = await Promise.all(
      sidebar.map(async (group) => ({
        title: group.text,
        pages: await Promise.all(
          (group.items ?? []).map(async (item) => {
            const file = `${item.link?.slice(1)}.md`
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
      `# awaywork\n\n> ${description}. An open-source CLI that runs the vendors' own agent CLIs (Claude Code, Codex) headless while they're away, on a developer's leftovers: red CI, review threads, QA feedback, requested reviews, plans. Output is a draft PR from a new branch or a morning report.\n\nEvery page is Markdown at its URL below; llms-full.txt has them all in one file.\n\n${index.join('\n\n')}\n`,
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
