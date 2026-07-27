# Technical annotations

EnvCAD uses native `AcDbMText` and `AcDbLeader` entities for multiline notes
and leaders, and a block-insert fallback for linear and radius dimensions.
Every annotation defaults to the `DIMENSIONS` layer. `add_radius_dimension`
and `add_mtext` may instead receive an explicit destination layer; the browser
creates the selected layer inside the same undoable edit when it does not exist.

## Why dimensions use the block fallback

`@mlightcad/data-model` 1.12.0 exposes `AcDbAlignedDimension`,
`AcDbRotatedDimension`, and `AcDbRadialDimension`, and all three have DXF input
and output fields. The reference viewer's `AcApDimLinearCmd` demonstrates the
extra step required for a visible aligned dimension: it calls
`AcDbAlignedDimension.createDimBlock()`, adds that anonymous block to the
database, assigns `dimBlockId`, and only then appends the dimension.

That complete creation/render path is not available for radial dimensions in
the pinned version. `AcDbRadialDimension` has no public `createDimBlock()`
equivalent, while the shared `AcDbDimension.subWorldDraw()` renders through the
entity's referenced dimension block. A newly constructed radial entity can be
filed to DXF, but it cannot produce its visible geometry through the same public
API used by the viewer. Using native dimensions for only some orientations
would make identical agent commands behave differently and leave radius
dimensions invisible.

For that reason, `add_linear_dimension` and `add_radius_dimension` both create
an ordinary named block definition containing:

- extension and dimension/leader lines;
- filled triangular `SOLID` arrowheads;
- centered `MTEXT` whose value is computed in code and displayed to exactly two
  decimals.

The tool then adds one `AcDbBlockReference` on the selected annotation layer
(`DIMENSIONS` by default). The insert is the only model-space entity returned
by the tool, so selection, move, delete, and undo treat the annotation as one
object. The block definition and insert are standard DXF records and survive
Save DXF followed by reopen.

This is a deliberate compatibility fallback, not an approximation of the
measurement. Horizontal dimensions use the exact X-coordinate difference,
vertical dimensions use the exact Y-coordinate difference, aligned dimensions
use Euclidean point-to-point distance, and radius dimensions read the
`AcDbCircle.radius` value directly from the public data-model API.

## Leader and MTEXT entities

`add_leader` creates an `AcDbLeader` and an associated `AcDbMText` in one
database edit. The leader stores the MTEXT object id as its associated
annotation, has an arrowhead and hook line, and both entity ids are returned.
`add_mtext` creates one native `AcDbMText`; its optional height is always in
drawing units.

All four tools run their complete mutation through one
`acapRunDatabaseEdit()` call. Consequently, each tool call creates exactly one
undo record even when it creates the `DIMENSIONS` layer, a block definition, or
both a leader and its text.
