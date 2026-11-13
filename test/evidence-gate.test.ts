import { mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const script = join(import.meta.dirname, '../plugin/skills/away/scripts/evidence-gate.sh')
const guide = join(import.meta.dirname, '../docs/guide/workflows.md')

async function gate(manifest: string | undefined, files: Record<string, string> = {}) {
  const out = await mkdtemp(join(tmpdir(), 'awaywork-evidence-'))
  if (manifest !== undefined) await writeFile(join(out, 'evidence.yml'), manifest)
  for (const [name, text] of Object.entries(files)) await writeFile(join(out, name), text)
  await symlink('/etc/hosts', join(out, 'link.png'))
  const ran = await execa('sh', [script], { env: { AWAYWORK_OUT_DIR: out }, reject: false })
  return { exit: ran.exitCode, stdout: ran.stdout }
}

const manifest = `criteria:
  - criterion: The Export button downloads the month's VAT report as CSV
    files: [export-click.png, export.csv]
  - criterion: A month with no invoices shows "Nothing to export"
    files:
      - "empty-month.png"
  - criterion: The CSV's total matches the invoice list's
    files: []
    gap: the preview has no seeded invoices
`
const files = { 'export-click.png': 'png', 'export.csv': 'a,b\n', 'empty-month.png': 'png' }

describe('evidence-gate.sh', () => {
  it('passes when every criterion names files the step left', async () => {
    const proven = manifest.replace('files: []', 'files: [totals.png]')
    expect(await gate(proven, { ...files, 'totals.png': 'png' })).toEqual({ exit: 0, stdout: '' })
  })

  it('fires with a line per criterion without a file, and per file that is missing, empty, a link or outside', async () => {
    expect(await gate(manifest, files)).toEqual({ exit: 1, stdout: 'no file for criterion 3' })
    const listed = 'files: [export-click.png, export.csv, gone.png, ../secret.png, link.png]'
    const broken = manifest.replace('files: [export-click.png, export.csv]', listed)
    expect(await gate(broken, { ...files, 'export.csv': '' })).toEqual({
      exit: 1,
      stdout: [
        'criterion 1: export.csv is missing or empty',
        'criterion 1: gone.png is missing or empty',
        "criterion 1: ../secret.png isn't a path in .away/out/",
        'criterion 1: link.png is missing or empty',
        'no file for criterion 3',
      ].join('\n'),
    })
  })

  it('fires without a manifest, and on one that lists no criterion', async () => {
    expect(await gate(undefined)).toEqual({ exit: 1, stdout: 'no evidence.yml' })
    expect(await gate('criteria: []\n')).toEqual({
      exit: 1,
      stdout: 'evidence.yml lists no criterion',
    })
  })

  it('is the script the guide shows', async () => {
    expect(await readFile(guide, 'utf8')).toContain(await readFile(script, 'utf8'))
  })
})
