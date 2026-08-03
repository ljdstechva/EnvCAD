import { acapRunDatabaseEdit } from '@mlightcad/cad-simple-viewer'
import type { AcDbDatabase } from '@mlightcad/data-model'
import type { CadOperationRequest } from '../../../../shared/agent-contracts'
import type { CadUndoGroups } from '../../ports/CadUndoGroups'
import { requireEditableCadSession } from '../../session'

interface ActiveUndoGroup {
  database: AcDbDatabase
  operationGroupId: string
  turnId: string
}

const ACTIVE_GROUPS = new WeakMap<AcDbDatabase, ActiveUndoGroup>()

export class MlightCadUndoGroupAdapter implements CadUndoGroups {
  private active: ActiveUndoGroup | undefined

  constructor(
    private readonly database: () => AcDbDatabase = () =>
      requireEditableCadSession().database
  ) {}

  begin(
    operation: Pick<CadOperationRequest, 'operationGroupId' | 'turnId'>
  ): void {
    const database = this.database()
    if (
      this.active?.database === database &&
      this.active.operationGroupId === operation.operationGroupId
    ) {
      return
    }
    this.finishActive()
    database.transactionManager.startUndoMark('AI action')
    this.active = {
      database,
      operationGroupId: operation.operationGroupId,
      turnId: operation.turnId
    }
    ACTIVE_GROUPS.set(database, this.active)
  }

  finishTurn(turnId: string): boolean {
    if (this.active?.turnId !== turnId) return false
    this.finishActive()
    return true
  }

  private finishActive(): void {
    const active = this.active
    if (!active) return
    this.active = undefined
    ACTIVE_GROUPS.delete(active.database)
    active.database.transactionManager.endUndoMark()
    notifyUndoAvailability(active.database)
  }
}

/**
 * Each CAD command remains its own committed transaction, while an active AI
 * operation group collects those commits into one user-facing undo record.
 */
export function runCadDatabaseEdit<T>(
  database: AcDbDatabase,
  label: string,
  callback: () => T
): T {
  if (!ACTIVE_GROUPS.has(database)) {
    let result!: T
    acapRunDatabaseEdit(database, label, () => {
      result = callback()
    })
    return result
  }

  const manager = database.transactionManager
  if (manager.hasTransaction()) return callback()
  manager.startTransaction()
  try {
    const result = callback()
    manager.commitTransaction()
    return result
  } catch (error) {
    if (manager.hasTransaction()) manager.abortTransaction()
    throw error
  }
}

function notifyUndoAvailability(database: AcDbDatabase): void {
  acapRunDatabaseEdit(database, 'AI action finalized', () => {
    // The empty edit only triggers the viewer's undo-stack notification.
  })
}
