import type { DrawingBounds } from './DrawingReadRecord'

export const drawingBoundsIntersect = (
  left: DrawingBounds,
  right: DrawingBounds
): boolean =>
  !(
    left.maxX < right.minX ||
    left.minX > right.maxX ||
    left.maxY < right.minY ||
    left.minY > right.maxY
  )

export const unionDrawingBounds = (
  left: DrawingBounds,
  right: DrawingBounds
): DrawingBounds => ({
  minX: Math.min(left.minX, right.minX),
  minY: Math.min(left.minY, right.minY),
  maxX: Math.max(left.maxX, right.maxX),
  maxY: Math.max(left.maxY, right.maxY)
})
