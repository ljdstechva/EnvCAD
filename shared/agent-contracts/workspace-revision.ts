import { z } from 'zod'

export const workspaceRevisionSchema = z.strictObject({
  documentId: z.string().min(1).max(200),
  documentRevision: z.number().int().nonnegative().safe(),
  contentRevision: z.number().int().nonnegative().safe(),
  sheetRevision: z.number().int().nonnegative().safe(),
  viewRevision: z.number().int().nonnegative().safe()
})

export type WorkspaceRevision = z.infer<typeof workspaceRevisionSchema>
export type WorkspaceRevisionTransitionKind =
  | 'same-document'
  | 'document-replaced'

export const INITIAL_WORKSPACE_REVISION: Readonly<WorkspaceRevision> = Object.freeze({
  documentId: 'no-document',
  documentRevision: 0,
  contentRevision: 0,
  sheetRevision: 0,
  viewRevision: 0
})

export const cloneWorkspaceRevision = (
  revision: WorkspaceRevision
): WorkspaceRevision => ({ ...revision })

export const sameWorkspaceRevision = (
  left: WorkspaceRevision,
  right: WorkspaceRevision
): boolean =>
  left.documentId === right.documentId &&
  left.documentRevision === right.documentRevision &&
  left.contentRevision === right.contentRevision &&
  left.sheetRevision === right.sheetRevision &&
  left.viewRevision === right.viewRevision

export const isWorkspaceRevision = (
  value: unknown
): value is WorkspaceRevision => workspaceRevisionSchema.safeParse(value).success

export const assertWorkspaceRevisionTransition = (
  previous: WorkspaceRevision,
  next: WorkspaceRevision,
  kind: WorkspaceRevisionTransitionKind
): void => {
  workspaceRevisionSchema.parse(previous)
  workspaceRevisionSchema.parse(next)

  if (kind === 'document-replaced') {
    if (next.documentId === previous.documentId) {
      throw new Error(
        'A document-replaced revision transition requires a new documentId.'
      )
    }
    if (next.documentRevision <= previous.documentRevision) {
      throw new Error(
        'A replacement documentRevision must be greater than the previous revision.'
      )
    }
    return
  }

  if (next.documentId !== previous.documentId) {
    throw new Error(
      'A documentId change requires an explicit document-replaced transition.'
    )
  }
  if (next.documentRevision !== previous.documentRevision) {
    throw new Error(
      'documentRevision cannot change while the documentId is unchanged.'
    )
  }
  for (const field of [
    'contentRevision',
    'sheetRevision',
    'viewRevision'
  ] as const) {
    if (next[field] < previous[field]) {
      throw new Error(`${field} cannot regress within the same document.`)
    }
  }
}
