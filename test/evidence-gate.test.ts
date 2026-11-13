import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execa, execaSync } from 'execa'
import { beforeAll, describe, expect, it } from 'vitest'

const script = join(import.meta.dirname, '../plugin/skills/away/scripts/evidence-gate.sh')

const present = (shell: string) =>
  !execaSync('sh', ['-c', `command -v ${shell}`], { reject: false }).failed
const shells = [['sh'], ['dash'], ['bash', '--posix'], ['ksh']].filter(([bin]) =>
  present(bin as string),
)

const left = {
  'a.png': 'png',
  'b.csv': 'a,b\n',
  'empty.png': '',
  'shots/c.png': 'png',
  'report.md': 'r',
}

/** The out dir a case runs on: `left`, its manifest, a link to a file and one to a folder. */
async function outDir(out: string, manifest: string | undefined) {
  for (const [name, text] of Object.entries(left)) {
    await mkdir(dirname(join(out, name)), { recursive: true })
    await writeFile(join(out, name), text)
  }
  if (manifest !== undefined) await writeFile(join(out, 'evidence.yml'), manifest)
  await symlink('/etc/hosts', join(out, 'link.png'))
  await symlink('/etc', join(out, 'd'))
}

const one = (lines: string) => `criteria:\n  - criterion: A\n${lines}\n`
const line = (n: number, why: string) => `evidence.yml line ${n}: ${why}`
const unread = 'not a criterion, files or gap line'
const notPlain = (name: string) => `criterion 1: ${name} isn't a plain path in .away/out/`

const clear: Record<string, string> = {
  'a list on one line': one('    files: [a.png, b.csv]'),
  'a name per line, quoted or not, in a folder': one(
    '    files:\n      - "a.png"\n      - \'b.csv\'\n    - shots/c.png',
  ),
  'a gap beside files, comments and blank lines': `# proof\ncriteria:\n\n  # first\n  - criterion: A\n    gap: partly\n    files: [ "a.png" ,b.csv ]\n`,
  'entries at the margin':
    'criteria:\n- criterion: A\n  files: [a.png]\n- criterion: B\n  files: [b.csv]\n',
  'a criterion with a colon, a quote and a dollar': `criteria:\n  - criterion: It's "done": $(rm -rf .) \`id\` $HOME *\n    files: [a.png]\n`,
}

const fires: Record<string, [manifest: string | undefined, stdout: string]> = {
  'no manifest': [undefined, 'no evidence.yml'],
  'an empty manifest': ['', 'evidence.yml lists no criterion'],
  'no criterion': ['# none\ncriteria:\n', 'evidence.yml lists no criterion'],
  'a flow list of criteria': ['criteria: []\n', line(1, 'expected "criteria:"')],
  'text that is no YAML': [
    'all three criteria are proven, see a.png\n',
    line(1, 'expected "criteria:"'),
  ],
  'a document marker': [`---\n${one('    files: [a.png]')}`, line(1, 'expected "criteria:"')],
  'another top-level key': [`${one('    files: [a.png]')}notes: none\n`, line(4, unread)],
  'no files key': [one('    gap: no preview'), 'no file for criterion 1'],
  'an empty list': [one('    files: []\n    gap: no preview'), 'no file for criterion 1'],
  'an empty block list': [one('    files:'), 'no file for criterion 1'],
  'files in a literal gap': [
    one('    files: []\n    gap: |\n      files: [a.png]'),
    line(4, unread),
  ],
  'files in a folded gap': [one('    gap: >\n      files: [a.png]'), line(3, unread)],
  'a criterion as a block': [
    'criteria:\n  - criterion: |\n      A\n    files: [a.png]\n',
    line(2, unread),
  ],
  'a criterion on two lines': [
    `criteria:\n  - criterion: A\n      and B\n    files: [a.png]\n`,
    line(3, unread),
  ],
  'files under another key': [one('    notes:\n      files: [a.png]'), line(3, unread)],
  'files deeper than the entry': [one('      files: [a.png]'), line(3, unread)],
  'files shallower than the entry': [one('  files: [a.png]'), line(3, unread)],
  'a tab for the indent': [one('\tfiles: [a.png]'), line(3, unread)],
  'files before any criterion': ['criteria:\n    files: [a.png]\n', line(2, unread)],
  'a list continued on the next line': [
    one('    files: [a.png,\n      gone.png]'),
    line(3, 'files is a list on one line, or one name per line under it'),
  ],
  'a comment after the list': [
    one('    files: [a.png] # shot'),
    line(3, 'files is a list on one line, or one name per line under it'),
  ],
  'a scalar for files': [
    one('    files: a.png'),
    line(3, 'files is a list on one line, or one name per line under it'),
  ],
  'a nested list': [one('    files: [[a.png]]'), line(3, 'a bracket in files')],
  'a trailing comma': [one('    files: [a.png,]'), line(3, 'an empty name in files')],
  'files twice': [
    one('    files: []\n    files: [a.png]'),
    line(4, 'criterion 1 already has files'),
  ],
  'gap twice': [
    one('    files: [a.png]\n    gap: x\n    gap: y'),
    line(5, 'criterion 1 already has a gap'),
  ],
  'quoted keys': ['criteria:\n  - "criterion": A\n    "files": []\n', line(2, unread)],
  'a quoted key after a proven criterion': [
    `${one('    files: [a.png]')}  - "criterion": B\n`,
    line(4, unread),
  ],
  'an entry at another indent': [
    `${one('    files: [a.png]')}    - criterion: B\n`,
    line(4, unread),
  ],
  'an item after the block ended': [
    one('    files:\n      - a.png\n    gap: x\n      - b.csv'),
    line(6, unread),
  ],
  'a criterion without a file after one with': [
    `${one('    files: [a.png]')}  - criterion: B\n  - criterion: C\n    files: [gone.png]\n`,
    'no file for criterion 2\ncriterion 3: gone.png is missing or empty',
  ],
  'a missing and an empty file': [
    one('    files: [a.png, gone.png, empty.png]'),
    'criterion 1: gone.png is missing or empty\ncriterion 1: empty.png is missing or empty',
  ],
  'a folder': [one('    files: [shots]'), 'criterion 1: shots is missing or empty'],
  'a link': [
    one('    files: [link.png]'),
    'criterion 1: link.png is a link, or in a linked folder',
  ],
  'a file in a linked folder': [
    one('    files: [d/hosts]'),
    'criterion 1: d/hosts is a link, or in a linked folder',
  ],
  'the manifest as proof': [
    one('    files: [evidence.yml]'),
    "criterion 1: evidence.yml is the step's own file, not proof",
  ],
  'the report as proof, in capitals': [
    one('    files:\n      - Report.md\n      - summary.md'),
    "criterion 1: Report.md is the step's own file, not proof\ncriterion 1: summary.md is the step's own file, not proof",
  ],
  'the report by a dotted path': [one('    files: [./report.md]'), notPlain('./report.md')],
  'the report by a doubled slash': [one('    files: [shots//c.png]'), notPlain('shots//c.png')],
  'a path out of the dir': [
    one('    files: [../a.png, /etc/hosts, shots/../a.png]'),
    [notPlain('../a.png'), notPlain('/etc/hosts'), notPlain('shots/../a.png')].join('\n'),
  ],
  'a name with a space, a glob or a command': [
    one('    files:\n      - a b.png\n      - "*.png"\n      - $(id).png\n      - -n'),
    [notPlain('a b.png'), notPlain('*.png'), notPlain('$(id).png')]
      .join('\n')
      .concat('\ncriterion 1: -n is missing or empty'),
  ],
  'a backslash in a name': [
    one('    files: [a\\tb.png, a.png\\]'),
    `${notPlain('a\\tb.png')}\n${notPlain('a.png\\')}`,
  ],
  'a quote inside a name': [one('    files: ["a.png", "b".csv]'), notPlain('"b".csv')],
  'a line ending in a carriage return': [
    one('    files: [a.png]\r'),
    line(3, 'files is a list on one line, or one name per line under it'),
  ],
}

const cases = [
  ...Object.entries(clear).map(([name, manifest]) => ({
    name: `passes on ${name}`,
    manifest,
    result: '0\n',
  })),
  ...Object.entries(fires).map(([name, [manifest, said]]) => ({
    name: `fires on ${name}`,
    manifest,
    result: `${said}\n1\n`,
  })),
].map((c, i) => ({ ...c, i }))

// One process per shell runs every case, each leaving its output and exit code beside its out dir.
const all =
  'dir=$1; shift; for out in "$dir"/*/; do AWAYWORK_OUT_DIR=${out%/} "$@" >"${out%/}.txt" 2>&1; echo $? >>"${out%/}.txt"; done'

describe.each(shells)('evidence-gate.sh under %s', (...shell) => {
  let dir = ''
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'awaywork-evidence-'))
    for (const { i, manifest } of cases) await outDir(join(dir, String(i)), manifest)
    await execa('sh', ['-c', all, 'sh', dir, ...(shell as string[]), script])
  })

  it.each(cases)('$name', async ({ i, result }) => {
    expect(await readFile(join(dir, `${i}.txt`), 'utf8')).toBe(result)
  })
})
