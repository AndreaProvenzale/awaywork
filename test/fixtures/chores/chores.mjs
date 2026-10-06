// One item per chore and repo; `updated` is the Monday of the week, so a chore comes back weekly.
const chores = [
  { name: 'tests', task: 'Add tests for the least tested module.' },
  { name: 'todos', task: 'Resolve one TODO comment.' },
]
const repos = ['acme/api', 'acme/web']
const now = new Date(process.env.CHORE_NOW ?? Date.now())
const monday = new Date(now)
monday.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7))
const updated = `${monday.toISOString().slice(0, 10)}T00:00:00Z`

const items = repos.flatMap((repo) =>
  chores.map(({ name, task }) => ({
    id: `${name}:${repo}`,
    key: `chore-${name}-${repo}`,
    type: 'task',
    title: `Chore: ${name} in ${repo}`,
    url: `https://example.com/chores/${name}`,
    description: task,
    fields: { chore: name, repo, updated },
  })),
)
console.log(JSON.stringify(items))
