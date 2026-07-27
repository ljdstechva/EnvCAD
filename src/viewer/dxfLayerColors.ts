import { AcCmColor, type AcDbDatabase } from '@mlightcad/data-model'

/**
 * mlightcad currently writes DXF true-colour group 420 correctly but does not
 * restore it when the drawing is opened again. Read only LAYER table records
 * and re-apply those colours after the library has parsed the document.
 */
export function parseDxfLayerTrueColors(source: string): Map<string, number> {
  const lines = source.replace(/^\uFEFF/, '').split(/\r?\n/)
  const colors = new Map<string, number>()
  let inLayerRecord = false
  let layerName: string | undefined
  let trueColor: number | undefined

  const finishLayerRecord = () => {
    if (layerName && trueColor !== undefined) {
      colors.set(layerName, trueColor)
    }
    layerName = undefined
    trueColor = undefined
  }

  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number(lines[index].trim())
    const value = lines[index + 1].trim()
    if (code === 0) {
      if (inLayerRecord) finishLayerRecord()
      inLayerRecord = value.toUpperCase() === 'LAYER'
      continue
    }
    if (!inLayerRecord) continue
    if (code === 2) {
      layerName = value
    } else if (code === 420) {
      const parsed = Number(value)
      if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffffff) {
        trueColor = parsed
      }
    }
  }
  if (inLayerRecord) finishLayerRecord()
  return colors
}

export function restoreDxfLayerTrueColors(
  database: AcDbDatabase,
  source: string
): number {
  let restored = 0
  for (const [name, trueColor] of parseDxfLayerTrueColors(source)) {
    const layer = database.tables.layerTable.getAt(name)
    if (!layer) continue
    layer.color = new AcCmColor().setRGBValue(trueColor)
    restored += 1
  }
  return restored
}
