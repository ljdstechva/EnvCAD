import type {
  AcDbDatabase,
  AcDbEntity,
  AcGeMatrix3d
} from '@mlightcad/data-model'

export function transformEntities(
  database: AcDbDatabase,
  entities: AcDbEntity[],
  matrix: AcGeMatrix3d
): number {
  let transformed = 0
  for (const entity of entities) {
    const opened = database.openEntityForWrite(entity)
    if (!opened) continue
    opened.transformBy(matrix)
    transformed += 1
  }
  return transformed
}

export function cloneAndTransformEntities(
  database: AcDbDatabase,
  entities: AcDbEntity[],
  matrix: AcGeMatrix3d
): AcDbEntity[] {
  const copies = entities.map((entity) => entity.clone())
  for (const copy of copies) copy.transformBy(matrix)
  if (copies.length > 0) {
    database.tables.blockTable.modelSpace.appendEntity(copies)
  }
  return copies
}

export function eraseEntities(
  database: AcDbDatabase,
  entityIds: string[]
): number {
  let erased = 0
  for (const entityId of entityIds) {
    const opened = database.openEntityForWrite(entityId)
    if (!opened) continue
    opened.erase()
    erased += 1
  }
  return erased
}
