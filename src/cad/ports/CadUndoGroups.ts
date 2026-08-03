import type { CadOperationRequest } from '../../../shared/agent-contracts'

export interface CadUndoGroups {
  begin(
    operation: Pick<CadOperationRequest, 'operationGroupId' | 'turnId'>
  ): void
  finishTurn(turnId: string): boolean
}
