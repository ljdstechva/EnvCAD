export interface DrawingBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface DrawingReadRecord {
  id: string
  layer: string
  type: string
  kind: string
  text?: string
  bounds?: DrawingBounds
  visible: boolean
  space: 'model' | 'paper'
  annotationType?: string
}

export interface DrawingReadQuery {
  entityIds?: readonly string[]
  layers?: readonly string[]
  types?: readonly string[]
  kinds?: readonly string[]
  textContains?: string
  bounds?: DrawingBounds
  visible?: boolean
  space?: 'model' | 'paper'
  annotationTypes?: readonly string[]
}

export interface DrawingLayerStatistics {
  entityCount: number
  entityKinds: ReadonlyMap<string, number>
}
