import {
  operationResultJsonSchema,
  sameWorkspaceRevision,
  toolInputJsonSchema,
  type CadOperationRequest,
  type JsonValue,
  type OperationReceipt,
  type WorkspaceRevision
} from '../../../shared/agent-contracts'
import {
  MutationCommitUnknownError,
  type MutationTransaction
} from './MutationTransaction'
import { OperationCoordinator } from './OperationCoordinator'
import {
  OperationPersistenceError,
  OperationStatusUnknownError,
  OperationUncertaintyBlockedError,
  StaleWorkspaceRevisionError,
  hashOperationArguments
} from './OperationReceipt'

export interface CadMutationToolResult {
  data?: unknown
  error?: string
}

export interface CadMutationExecution {
  result: CadMutationToolResult
  receipt?: OperationReceipt
}

export interface CadMutationExecutorOptions {
  coordinator: OperationCoordinator
  currentRevision(): WorkspaceRevision
  beginOperationGroup?: (request: CadOperationRequest) => void
}

export class CadMutationExecutor {
  constructor(private readonly options: CadMutationExecutorOptions) {}

  async execute(
    request: CadOperationRequest,
    input: unknown,
    handler: (input: unknown) => Promise<CadMutationToolResult>,
    signal: AbortSignal
  ): Promise<CadMutationExecution> {
    const parsedInput = toolInputJsonSchema.safeParse(input)
    if (!parsedInput.success) {
      return {
        result: {
          error: 'EnvCAD rejected invalid or excessive mutation arguments.'
        }
      }
    }
    try {
      const execution = await this.options.coordinator.execute(
        request,
        parsedInput.data,
        this.transaction(request, parsedInput.data, handler),
        signal
      )
      if (execution.receipt.status !== 'committed' || execution.result === undefined) {
        return {
          receipt: execution.receipt,
          result: {
            error: `CAD operation ${request.operationId} is ${execution.receipt.status}; EnvCAD will not repeat it automatically.`
          }
        }
      }
      return {
        receipt: execution.receipt,
        result: { data: execution.result }
      }
    } catch (error) {
      const receipt = await this.options.coordinator.getReceipt(
        request.operationId
      )
      return {
        ...(receipt ? { receipt } : {}),
        result: { error: safeMutationError(error) }
      }
    }
  }

  private transaction(
    request: CadOperationRequest,
    input: JsonValue,
    handler: (input: unknown) => Promise<CadMutationToolResult>
  ): MutationTransaction<JsonValue> {
    return {
      execute: async (_operation, signal) => {
        const revisionBefore = this.options.currentRevision()
        if (signal.aborted) throw abortError()
        this.options.beginOperationGroup?.(request)
        const result = await handler(input)
        const revisionAfter = this.options.currentRevision()
        if (result.error) {
          if (!sameWorkspaceRevision(revisionBefore, revisionAfter)) {
            throw new MutationCommitUnknownError(
              'The CAD handler reported an error after the workspace changed.',
              await evidenceFingerprint(request, revisionAfter, [])
            )
          }
          throw new Error(result.error)
        }
        const data = durableJson(result.data)
        const affectedEntityIds = affectedIds(data)
        if (signal.aborted) {
          if (!sameWorkspaceRevision(revisionBefore, revisionAfter)) {
            throw new MutationCommitUnknownError(
              'Cancellation arrived after the workspace revision changed.',
              await evidenceFingerprint(
                request,
                revisionAfter,
                affectedEntityIds
              )
            )
          }
          throw abortError()
        }
        return {
          result: data,
          revisionBefore,
          revisionAfter,
          affectedEntityIds,
          reconciliationFingerprint: await evidenceFingerprint(
            request,
            revisionAfter,
            affectedEntityIds
          )
        }
      }
    }
  }
}

function durableJson(value: unknown): JsonValue {
  if (value === undefined) {
    throw new Error('CAD mutation returned no result data.')
  }
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new Error('CAD mutation returned non-serializable result data.')
  }
  return operationResultJsonSchema.parse(JSON.parse(serialized))
}

function affectedIds(result: JsonValue): string[] {
  if (
    typeof result !== 'object' ||
    result === null ||
    Array.isArray(result) ||
    !Array.isArray(result.entityIds)
  ) {
    return []
  }
  return [
    ...new Set(
      result.entityIds.filter(
        (value): value is string =>
          typeof value === 'string' && value.length > 0 && value.length <= 200
      )
    )
  ].slice(0, 1_000)
}

function evidenceFingerprint(
  request: CadOperationRequest,
  revisionAfter: WorkspaceRevision,
  affectedEntityIds: string[]
): Promise<string> {
  return hashOperationArguments(`receipt:${request.toolName}`, {
    operationId: request.operationId,
    revisionAfter,
    affectedEntityIds
  })
}

function safeMutationError(error: unknown): string {
  if (error instanceof StaleWorkspaceRevisionError) {
    return 'The complete workspace revision changed before mutation. No automatic retry was attempted.'
  }
  if (
    error instanceof OperationStatusUnknownError ||
    error instanceof OperationUncertaintyBlockedError
  ) {
    return `${error.message} EnvCAD will not repeat an uncertain mutation automatically.`
  }
  if (error instanceof OperationPersistenceError) {
    return `EnvCAD could not durably finalize operation ${error.operationId}. Drawing change status: ${String(error.drawingChanged)}. No automatic retry was attempted.`
  }
  return error instanceof Error
    ? error.message
    : 'The CAD mutation failed before a safe result was available.'
}

function abortError(): Error {
  const error = new Error('CAD operation was cancelled.')
  error.name = 'AbortError'
  return error
}
