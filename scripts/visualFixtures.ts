export type VisualMarkerShape = 'circle' | 'square' | 'triangle'
export type VisualMarkerColor =
  | 'red'
  | 'yellow'
  | 'green'
  | 'cyan'
  | 'blue'
  | 'magenta'
export type VisualMarkerQuadrant =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
export type VisualFixtureId = 'a' | 'b' | 'blank' | 'defect'

export interface VisualMarkerExpectation {
  color: VisualMarkerColor
  shape: VisualMarkerShape
  quadrant: VisualMarkerQuadrant
}

export interface VisualFixtureExpectation {
  id: VisualFixtureId
  blank: boolean
  orientation: 'landscape'
  borderVisible: true
  titleBlockVisible: false
  clipping: boolean
  overlap: boolean
  markers: VisualMarkerExpectation[]
}

interface MarkerDefinition extends VisualMarkerExpectation {
  x: number
  y: number
}

const COLOR_INDEX: Record<VisualMarkerColor, number> = {
  red: 1,
  yellow: 2,
  green: 3,
  cyan: 4,
  blue: 5,
  magenta: 6
}

const ARRANGEMENTS: Record<'a' | 'b', MarkerDefinition[]> = {
  a: [
    { color: 'red', shape: 'circle', quadrant: 'top-left', x: -22, y: 13 },
    { color: 'green', shape: 'square', quadrant: 'top-right', x: 22, y: 13 },
    {
      color: 'blue',
      shape: 'triangle',
      quadrant: 'bottom-left',
      x: -22,
      y: -13
    },
    {
      color: 'yellow',
      shape: 'circle',
      quadrant: 'bottom-right',
      x: 22,
      y: -13
    }
  ],
  b: [
    {
      color: 'cyan',
      shape: 'triangle',
      quadrant: 'top-left',
      x: -22,
      y: 13
    },
    {
      color: 'yellow',
      shape: 'square',
      quadrant: 'top-right',
      x: 22,
      y: 13
    },
    {
      color: 'magenta',
      shape: 'circle',
      quadrant: 'bottom-left',
      x: -22,
      y: -13
    },
    {
      color: 'red',
      shape: 'triangle',
      quadrant: 'bottom-right',
      x: 22,
      y: -13
    }
  ]
}

export function visualFixtureExpectation(
  id: VisualFixtureId
): VisualFixtureExpectation {
  if (id === 'blank') {
    return {
      id,
      blank: true,
      orientation: 'landscape',
      borderVisible: true,
      titleBlockVisible: false,
      clipping: false,
      overlap: false,
      markers: []
    }
  }
  if (id === 'defect') {
    return {
      id,
      blank: false,
      orientation: 'landscape',
      borderVisible: true,
      titleBlockVisible: false,
      clipping: true,
      overlap: true,
      markers: [
        {
          color: 'red',
          shape: 'circle',
          quadrant: 'top-left'
        },
        {
          color: 'blue',
          shape: 'square',
          quadrant: 'bottom-right'
        },
        {
          color: 'green',
          shape: 'circle',
          quadrant: 'bottom-right'
        }
      ]
    }
  }
  return {
    id,
    blank: false,
    orientation: 'landscape',
    borderVisible: true,
    titleBlockVisible: false,
    clipping: false,
    overlap: false,
    markers: ARRANGEMENTS[id].map(({ color, shape, quadrant }) => ({
      color,
      shape,
      quadrant
    }))
  }
}

/**
 * Creates a complete, text-free ASCII DXF. Layer names are opaque and carry
 * no color, shape, position, fixture, or acceptance-answer semantics.
 */
export function createVisualFixtureDxf(id: VisualFixtureId): string {
  const markers =
    id === 'a' || id === 'b'
      ? ARRANGEMENTS[id]
      : id === 'defect'
        ? defectMarkers()
        : []
  const layerColors = [
    ...new Set(markers.map((marker) => marker.color))
  ].sort()
  const layers = layerColors.map((color, index) => ({
    name: `L${index + 1}`,
    color,
    colorIndex: COLOR_INDEX[color]
  }))
  const layerForColor = new Map(
    layers.map((layer) => [layer.color, layer.name])
  )
  const lines: string[] = []
  let handle = 0x30
  const nextHandle = () => {
    handle += 1
    return handle.toString(16).toUpperCase()
  }
  const push = (code: number, value: string | number) => {
    lines.push(String(code), String(value))
  }

  push(0, 'SECTION')
  push(2, 'HEADER')
  push(9, '$ACADVER')
  push(1, 'AC1015')
  push(9, '$INSUNITS')
  push(70, 6)
  push(0, 'ENDSEC')

  push(0, 'SECTION')
  push(2, 'TABLES')
  push(0, 'TABLE')
  push(2, 'LAYER')
  push(70, layers.length)
  for (const layer of layers) {
    push(0, 'LAYER')
    push(5, nextHandle())
    push(100, 'AcDbSymbolTableRecord')
    push(100, 'AcDbLayerTableRecord')
    push(2, layer.name)
    push(70, 0)
    push(62, layer.colorIndex)
    push(6, 'CONTINUOUS')
  }
  push(0, 'ENDTAB')
  push(0, 'TABLE')
  push(2, 'BLOCK_RECORD')
  push(5, '2')
  push(330, '0')
  push(100, 'AcDbSymbolTable')
  push(70, 1)
  push(0, 'BLOCK_RECORD')
  push(5, '10')
  push(330, '2')
  push(100, 'AcDbSymbolTableRecord')
  push(100, 'AcDbBlockTableRecord')
  push(2, '*Model_Space')
  push(70, 0)
  push(280, 1)
  push(281, 0)
  push(0, 'ENDTAB')
  push(0, 'ENDSEC')

  push(0, 'SECTION')
  push(2, 'BLOCKS')
  push(0, 'BLOCK')
  push(5, '11')
  push(330, '10')
  push(100, 'AcDbEntity')
  push(8, '0')
  push(100, 'AcDbBlockBegin')
  push(2, '*Model_Space')
  push(70, 0)
  push(10, 0)
  push(20, 0)
  push(30, 0)
  push(3, '*Model_Space')
  push(1, '')
  push(0, 'ENDBLK')
  push(5, '12')
  push(330, '10')
  push(100, 'AcDbEntity')
  push(8, '0')
  push(100, 'AcDbBlockEnd')
  push(0, 'ENDSEC')

  push(0, 'SECTION')
  push(2, 'ENTITIES')
  for (const marker of markers) {
    const layer = layerForColor.get(marker.color)
    if (!layer) throw new Error('Visual fixture layer assignment failed.')
    // Closely nested outlines make the markers unmistakable at full-sheet
    // model resolution without relying on renderer-specific lineweight rules.
    for (let band = 0; band < 5; band += 1) {
      const radius = 6 - band * 0.35
      if (marker.shape === 'circle') {
        addCircle(push, nextHandle(), layer, marker.x, marker.y, radius)
      } else {
        const points =
          marker.shape === 'square'
            ? ([
                [marker.x - radius, marker.y - radius],
                [marker.x + radius, marker.y - radius],
                [marker.x + radius, marker.y + radius],
                [marker.x - radius, marker.y + radius]
              ] as Array<[number, number]>)
            : ([
                [marker.x, marker.y + radius + 1],
                [marker.x + radius + 1, marker.y - radius],
                [marker.x - radius - 1, marker.y - radius]
              ] as Array<[number, number]>)
        addPolyline(push, nextHandle(), layer, points)
      }
    }
  }
  push(0, 'ENDSEC')
  push(0, 'EOF')
  return `${lines.join('\n')}\n`
}

function defectMarkers(): MarkerDefinition[] {
  return [
    {
      color: 'red',
      shape: 'circle',
      quadrant: 'top-left',
      x: -60,
      y: 18
    },
    {
      color: 'blue',
      shape: 'square',
      quadrant: 'bottom-right',
      x: 18,
      y: -10
    },
    {
      color: 'green',
      shape: 'circle',
      quadrant: 'bottom-right',
      x: 21,
      y: -8
    }
  ]
}

function addEntityPreamble(
  push: (code: number, value: string | number) => void,
  type: 'CIRCLE' | 'LWPOLYLINE',
  handle: string,
  layer: string
): void {
  push(0, type)
  push(5, handle)
  push(330, '10')
  push(100, 'AcDbEntity')
  push(8, layer)
  push(370, 100)
}

function addCircle(
  push: (code: number, value: string | number) => void,
  handle: string,
  layer: string,
  x: number,
  y: number,
  radius: number
): void {
  addEntityPreamble(push, 'CIRCLE', handle, layer)
  push(100, 'AcDbCircle')
  push(10, x.toFixed(3))
  push(20, y.toFixed(3))
  push(30, '0.0')
  push(40, radius.toFixed(3))
}

function addPolyline(
  push: (code: number, value: string | number) => void,
  handle: string,
  layer: string,
  points: Array<[number, number]>
): void {
  addEntityPreamble(push, 'LWPOLYLINE', handle, layer)
  push(100, 'AcDbPolyline')
  push(90, points.length)
  push(70, 1)
  for (const [x, y] of points) {
    push(10, x.toFixed(3))
    push(20, y.toFixed(3))
  }
}
