import type { SheetDefinition, SheetRenderResult, SheetRenderer } from '../../sheet/types'
import { PAPER_SIZES } from '../../sheet/types'

/**
 * Fallback renderer used until the real SheetRenderer lands in src/sheet/renderSheet.ts.
 * Draws an empty page with a border and a dashed margin outline so the preview/PDF
 * pipeline can be built and tested end to end ahead of that renderer landing.
 */
class StubSheetRenderer implements SheetRenderer {
  async render(_doc: unknown, sheet: SheetDefinition): Promise<SheetRenderResult> {
    const base = PAPER_SIZES[sheet.paper]
    const widthMm = sheet.orientation === 'landscape' ? base.heightMm : base.widthMm
    const heightMm = sheet.orientation === 'landscape' ? base.widthMm : base.heightMm
    const innerWidth = Math.max(0, widthMm - sheet.marginsMm.left - sheet.marginsMm.right)
    const innerHeight = Math.max(0, heightMm - sheet.marginsMm.top - sheet.marginsMm.bottom)

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${widthMm} ${heightMm}" width="${widthMm}mm" height="${heightMm}mm">
  <rect x="0.25" y="0.25" width="${widthMm - 0.5}" height="${heightMm - 0.5}" fill="#ffffff" stroke="#333333" stroke-width="0.3" />
  <rect x="${sheet.marginsMm.left}" y="${sheet.marginsMm.top}" width="${innerWidth}" height="${innerHeight}" fill="none" stroke="#999999" stroke-width="0.15" stroke-dasharray="2,1.5" />
</svg>`

    return { svg, warnings: [] }
  }
}

const stub = new StubSheetRenderer()

// Loaded lazily via import.meta.glob so a missing src/sheet/renderSheet.ts does not
// break the dev server or production build; once that file exists this resolves it,
// including when it is added later while the dev server keeps running.
const realRendererModules = import.meta.glob('../../sheet/renderSheet.ts')

let resolvedReal: SheetRenderer | null = null

async function resolveRealRenderer(): Promise<SheetRenderer | null> {
  if (resolvedReal) return resolvedReal
  const loader = realRendererModules['../../sheet/renderSheet.ts']
  if (!loader) return null
  try {
    const mod = (await loader()) as Record<string, unknown>
    const candidates = [mod.sheetRenderer, mod.default, mod.renderer]
    for (const candidate of candidates) {
      if (
        candidate &&
        typeof (candidate as SheetRenderer).render === 'function'
      ) {
        resolvedReal = candidate as SheetRenderer
        return resolvedReal
      }
    }
    const renderFn = mod.renderSheet
    if (typeof renderFn === 'function') {
      resolvedReal = { render: renderFn as SheetRenderer['render'] }
      return resolvedReal
    }
  } catch {
    // real renderer module exists but failed to load/export correctly — use stub
  }
  return null
}

export async function getSheetRenderer(): Promise<SheetRenderer> {
  const real = await resolveRealRenderer()
  return real ?? stub
}
