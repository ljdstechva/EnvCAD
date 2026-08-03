import {
  cadOperationRequestSchema,
  getToolManifestEntry,
  sameWorkspaceRevision,
  toolInputJsonSchema,
  toolSuccessResultSchema,
  workspaceRevisionSchema,
  type CadOperationRequest,
  type JsonValue,
  type OperationCommit,
  type WorkspaceRevision
} from '../../../shared/agent-contracts'
import {
  hashOperationArguments,
  OperationArgumentsHashMismatchError,
  StaleWorkspaceRevisionError
} from './OperationReceipt'

export interface OperationExecutionValidatorOptions {
  currentRevision(): WorkspaceRevision
  now(): Date
}

export class OperationExecutionValidator {
  constructor(private readonly options: OperationExecutionValidatorOptions) {}

  async validateIdentity(
    request: CadOperationRequest,
    actualInput: JsonValue
  ): Promise<void> {
    if (!cadOperationRequestSchema.safeParse(request).success) {
      throw new Error('Invalid CAD operation request.')
    }
    if (!toolInputJsonSchema.safeParse(actualInput).success) {
      throw new Error('Invalid or excessive CAD operation input.')
    }
    const manifest = getToolManifestEntry(request.toolName)
    if (manifest?.mutability !== 'write') {
      throw new Error('OperationCoordinator accepts mutating CAD tools only.')
    }
    if (
      request.toolName === 'measure_clearance' &&
      (typeof actualInput !== 'object' ||
        actualInput === null ||
        Array.isArray(actualInput) ||
        actualInput.draw !== true)
    ) {
      throw new Error('Read-only clearance measurement needs no operation wrapper.')
    }
    const actualHash = await hashOperationArguments(
      request.toolName,
      actualInput
    )
    if (actualHash !== request.argumentsHash) {
      throw new OperationArgumentsHashMismatchError(request.operationId)
    }
  }

  validateDeadline(request: CadOperationRequest): void {
    if (Date.parse(request.deadline) <= this.options.now().getTime()) {
      throw new Error('CAD operation deadline elapsed before execution.')
    }
  }

  assertExpectedRevision(
    request: CadOperationRequest,
    actual: WorkspaceRevision
  ): void {
    if (!sameWorkspaceRevision(actual, request.expectedRevision)) {
      throw new StaleWorkspaceRevisionError(request.expectedRevision, actual)
    }
  }

  validateCommit<T extends JsonValue>(
    request: CadOperationRequest,
    commit: OperationCommit<T>
  ): void {
    this.validateCommitShape(commit)
    const before = commit.revisionBefore
    const after = commit.revisionAfter
    if (
      !sameWorkspaceRevision(before, request.expectedRevision) ||
      !sameWorkspaceRevision(after, this.options.currentRevision())
    ) {
      throw new Error('CAD transaction returned inconsistent workspace revisions.')
    }
    this.validateRevisionChange(request.toolName, before, after)
  }

  private validateCommitShape<T extends JsonValue>(
    commit: OperationCommit<T>
  ): void {
    if (
      !workspaceRevisionSchema.safeParse(commit.revisionBefore).success ||
      !workspaceRevisionSchema.safeParse(commit.revisionAfter).success ||
      !toolSuccessResultSchema.safeParse({
        ok: true,
        data: commit.result
      }).success
    ) {
      throw new Error('CAD transaction returned invalid or excessive output.')
    }
    if (
      !/^[a-f0-9]{64}$/.test(commit.reconciliationFingerprint) ||
      (commit.resultHash !== undefined &&
        !/^[a-f0-9]{64}$/.test(commit.resultHash)) ||
      commit.affectedEntityIds.length > 1_000 ||
      new Set(commit.affectedEntityIds).size !== commit.affectedEntityIds.length ||
      commit.affectedEntityIds.some(
        (id) => id.length === 0 || id.length > 200
      )
    ) {
      throw new Error('CAD transaction returned invalid reconciliation evidence.')
    }
  }

  private validateRevisionChange(
    toolName: string,
    before: WorkspaceRevision,
    after: WorkspaceRevision
  ): void {
    if (
      after.documentId !== before.documentId ||
      after.documentRevision !== before.documentRevision
    ) {
      throw new Error('A CAD operation cannot replace the active document.')
    }
    if (toolName === 'zoom_extents') {
      this.assertOnlyRevisionAdvanced('view', before, after)
      return
    }
    if (
      toolName === 'set_sheet_definition' ||
      toolName === 'set_title_block_fields'
    ) {
      this.assertOnlyRevisionAdvanced('sheet', before, after)
      return
    }
    this.assertOnlyRevisionAdvanced('content', before, after)
  }

  private assertOnlyRevisionAdvanced(
    component: 'content' | 'sheet' | 'view',
    before: WorkspaceRevision,
    after: WorkspaceRevision
  ): void {
    const revisions = {
      content: [before.contentRevision, after.contentRevision],
      sheet: [before.sheetRevision, after.sheetRevision],
      view: [before.viewRevision, after.viewRevision]
    } as const
    for (const [name, [previous, next]] of Object.entries(revisions)) {
      const expectedToAdvance = name === component
      if (
        (expectedToAdvance && next <= previous) ||
        (!expectedToAdvance && next !== previous)
      ) {
        throw new Error(
          `${component} mutation returned an inconsistent ${name} revision.`
        )
      }
    }
  }
}
