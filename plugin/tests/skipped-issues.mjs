// A skipped GitHub issue as `report --json` prints it. Plain JS: both test runners can load it.
export const notYours = {
  source: 'github',
  key: 'acme/shop#9',
  title: 'Bump the linter',
  url: 'https://github.com/acme/shop/issues/9',
  type: 'issue',
}

export const yours = { ...notYours, mine: true }
