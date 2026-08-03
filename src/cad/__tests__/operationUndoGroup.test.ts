import { describe, expect, it } from 'vitest'
import { AcDbDatabase, AcDbPolyline } from '@mlightcad/data-model'
import {
  MlightCadUndoGroupAdapter,
  runCadDatabaseEdit
} from '../infrastructure/mlightcad/MlightCadUndoGroupAdapter'

function appendPolyline(database: AcDbDatabase): string {
  const entity = new AcDbPolyline()
  database.tables.blockTable.modelSpace.appendEntity(entity)
  return entity.objectId
}

describe('AI operation undo grouping', () => {
  it('merges separately committed CAD operations into one undo record', () => {
    const database = new AcDbDatabase()
    const groups = new MlightCadUndoGroupAdapter(() => database)
    groups.begin({ turnId: 'turn-1', operationGroupId: 'group-1' })

    const first = runCadDatabaseEdit(database, 'first', () =>
      appendPolyline(database)
    )
    const second = runCadDatabaseEdit(database, 'second', () =>
      appendPolyline(database)
    )
    expect(database.tables.blockTable.getEntityById(first)).toBeDefined()
    expect(database.tables.blockTable.getEntityById(second)).toBeDefined()

    expect(groups.finishTurn('turn-1')).toBe(true)
    expect(database.transactionManager.undo()).toBe(true)
    expect(database.tables.blockTable.getEntityById(first)).toBeUndefined()
    expect(database.tables.blockTable.getEntityById(second)).toBeUndefined()
    expect(database.transactionManager.canUndo()).toBe(false)
  })

  it('rolls back a partial command without discarding prior group commits', () => {
    const database = new AcDbDatabase()
    const groups = new MlightCadUndoGroupAdapter(() => database)
    groups.begin({ turnId: 'turn-1', operationGroupId: 'group-1' })
    const committed = runCadDatabaseEdit(database, 'committed', () =>
      appendPolyline(database)
    )
    let partialId = ''

    expect(() =>
      runCadDatabaseEdit(database, 'faulted', () => {
        partialId = appendPolyline(database)
        throw new Error('Injected postcondition failure.')
      })
    ).toThrow('Injected postcondition failure')
    expect(database.tables.blockTable.getEntityById(committed)).toBeDefined()
    expect(database.tables.blockTable.getEntityById(partialId)).toBeUndefined()

    groups.finishTurn('turn-1')
    database.transactionManager.undo()
    expect(database.tables.blockTable.getEntityById(committed)).toBeUndefined()
  })
})
