export interface RevisionGuardedCaptureOptions<Preview, Raster> {
  render(attempt: number): Promise<Preview>
  rasterize(preview: Preview, attempt: number): Promise<Raster>
  isCurrent(preview: Preview): boolean
  onStale(): void
}

/**
 * Produces a capture only when its source revision is still current after the
 * asynchronous raster encode. A single stale result is retried; a second is
 * rejected so callers can never receive bytes from an obsolete document.
 */
export async function captureWithRevisionRetry<Preview, Raster>(
  options: RevisionGuardedCaptureOptions<Preview, Raster>
): Promise<{ preview: Preview; raster: Raster }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const preview = await options.render(attempt)
    const raster = await options.rasterize(preview, attempt)
    if (options.isCurrent(preview)) return { preview, raster }
    options.onStale()
  }
  throw new Error(
    'The drawing or Sheet Preview changed twice during image capture; no stale image was returned.'
  )
}
