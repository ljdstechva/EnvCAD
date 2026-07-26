import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Minimal but well-formed ASCII DXF (AC1015 / AutoCAD 2000 format) with a
// LAYER table so layer color/visibility round-trips, plus a handful of
// entities spread across layers for exercising open/select/save.

interface Layer {
  name: string
  colorIndex: number
}

const layers: Layer[] = [
  { name: 'BOUNDARY', colorIndex: 7 },
  { name: 'BUILDINGS', colorIndex: 5 },
  { name: 'ANNOTATION', colorIndex: 2 },
  { name: 'FACILITIES', colorIndex: 4 }
]

let handle = 0x30
function nextHandle(): string {
  handle += 1
  return handle.toString(16).toUpperCase()
}

const lines: string[] = []

function push(code: number, value: string | number) {
  lines.push(String(code))
  lines.push(String(value))
}

// ---- HEADER ----
push(0, 'SECTION')
push(2, 'HEADER')
push(9, '$ACADVER')
push(1, 'AC1015')
push(9, '$INSUNITS')
push(70, 6) // 6 = meters
push(0, 'ENDSEC')

// ---- TABLES (LAYER table) ----
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
push(0, 'ENDSEC')

// ---- ENTITIES ----
push(0, 'SECTION')
push(2, 'ENTITIES')

function lwpolyline(layer: string, points: [number, number][], closed: boolean) {
  push(0, 'LWPOLYLINE')
  push(5, nextHandle())
  push(100, 'AcDbEntity')
  push(8, layer)
  push(100, 'AcDbPolyline')
  push(90, points.length)
  push(70, closed ? 1 : 0)
  for (const [x, y] of points) {
    push(10, x.toFixed(3))
    push(20, y.toFixed(3))
  }
}

function mtext(layer: string, x: number, y: number, height: number, text: string) {
  push(0, 'MTEXT')
  push(5, nextHandle())
  push(100, 'AcDbEntity')
  push(8, layer)
  push(100, 'AcDbMText')
  push(10, x.toFixed(3))
  push(20, y.toFixed(3))
  push(30, '0.0')
  push(40, height.toFixed(3))
  push(71, 1)
  push(1, text)
}

function circle(layer: string, cx: number, cy: number, radius: number) {
  push(0, 'CIRCLE')
  push(5, nextHandle())
  push(100, 'AcDbEntity')
  push(8, layer)
  push(100, 'AcDbCircle')
  push(10, cx.toFixed(3))
  push(20, cy.toFixed(3))
  push(30, '0.0')
  push(40, radius.toFixed(3))
}

// Site boundary: ~100m x 60m closed polyline
lwpolyline(
  'BOUNDARY',
  [
    [0, 0],
    [100, 0],
    [100, 60],
    [0, 60]
  ],
  true
)

// Two buildings
lwpolyline(
  'BUILDINGS',
  [
    [10, 10],
    [30, 10],
    [30, 25],
    [10, 25]
  ],
  true
)
lwpolyline(
  'BUILDINGS',
  [
    [45, 10],
    [70, 10],
    [70, 22],
    [45, 22]
  ],
  true
)

// Annotation labels
mtext('ANNOTATION', 12, 27, 2, 'ADMIN BUILDING')
mtext('ANNOTATION', 47, 24, 2, 'PROCESS BUILDING')
mtext('ANNOTATION', 5, 55, 3, 'SAMPLE SITE PLAN')

// Circular tank (facility)
circle('FACILITIES', 85, 45, 8)

push(0, 'ENDSEC')
push(0, 'EOF')

const dxfContent = lines.join('\n') + '\n'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outPath = join(__dirname, 'sample-site.dxf')
writeFileSync(outPath, dxfContent, 'utf-8')
console.log(`Wrote ${outPath} (${dxfContent.length} bytes)`)
