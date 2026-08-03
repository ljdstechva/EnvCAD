import {
  cloneWorkspaceRevision,
  INITIAL_WORKSPACE_REVISION,
  type WorkspaceRevision
} from '../../../shared/agent-contracts/workspace-revision'

export type WorkspaceDocumentKind = 'document' | 'no-document'

type IdFactory = () => string

function defaultIdFactory(): string {
  return globalThis.crypto.randomUUID()
}

/**
 * Owns the monotonic renderer-side workspace revision.
 *
 * Document identity is opaque and session-scoped until a durable CAD snapshot
 * identity is available. Callers must not infer a file name or path from it.
 */
export class WorkspaceRevisionClock {
  private revision: WorkspaceRevision

  constructor(private readonly idFactory: IdFactory = defaultIdFactory) {
    this.revision = cloneWorkspaceRevision(INITIAL_WORKSPACE_REVISION)
  }

  snapshot(): WorkspaceRevision {
    return cloneWorkspaceRevision(this.revision)
  }

  advanceDocument(kind: WorkspaceDocumentKind): WorkspaceRevision {
    this.revision = {
      documentId: `${kind}:${this.idFactory()}`,
      documentRevision: nextCounter(
        this.revision.documentRevision,
        'documentRevision'
      ),
      contentRevision: 0,
      sheetRevision: 0,
      viewRevision: 0
    }
    return this.snapshot()
  }

  advanceContent(): WorkspaceRevision {
    this.revision.contentRevision = nextCounter(
      this.revision.contentRevision,
      'contentRevision'
    )
    return this.snapshot()
  }

  advanceSheet(): WorkspaceRevision {
    this.revision.sheetRevision = nextCounter(
      this.revision.sheetRevision,
      'sheetRevision'
    )
    return this.snapshot()
  }

  advanceView(): WorkspaceRevision {
    this.revision.viewRevision = nextCounter(
      this.revision.viewRevision,
      'viewRevision'
    )
    return this.snapshot()
  }
}

function nextCounter(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new Error(`${name} cannot advance beyond the safe integer range.`)
  }
  return value + 1
}
