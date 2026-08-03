import { createHash } from 'node:crypto'

export function turnEventId(turnId: string, logicalId: string): string {
  return createHash('sha256')
    .update('envcad-turn-event-v2\0', 'utf8')
    .update(turnId, 'utf8')
    .update('\0', 'utf8')
    .update(logicalId, 'utf8')
    .digest('hex')
}
