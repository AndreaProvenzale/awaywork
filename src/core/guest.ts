import type { Unit } from './types'

/** Someone else's PR whose author isn't on the `trust` list: it gets none of your own PR's grants. */
export const guest = (unit: Pick<Unit, 'foreign' | 'lent'>): boolean => unit.foreign && !unit.lent
