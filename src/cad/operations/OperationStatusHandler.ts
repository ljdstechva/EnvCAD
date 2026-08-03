import type { OperationStatusResult } from '../../../shared/agent-contracts'
import type { OperationLedger } from './OperationLedger'

export class OperationStatusHandler {
  constructor(private readonly ledger: OperationLedger) {}

  async handle(operationId: string): Promise<OperationStatusResult> {
    if (operationId.trim() === '') {
      throw new Error('operationId must not be blank.')
    }
    const receipt = await this.ledger.getByOperationId(operationId)
    return {
      operationId,
      ...(receipt ? { receipt } : {})
    }
  }
}
