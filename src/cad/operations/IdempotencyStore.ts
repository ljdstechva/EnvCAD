export interface IdempotencyStore {
  getOperationId(idempotencyKey: string): Promise<string | undefined>
  bind(
    idempotencyKey: string,
    operationId: string
  ): Promise<{ operationId: string; created: boolean }>
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly operationIds = new Map<string, string>()

  async getOperationId(idempotencyKey: string): Promise<string | undefined> {
    return this.operationIds.get(idempotencyKey)
  }

  async bind(
    idempotencyKey: string,
    operationId: string
  ): Promise<{ operationId: string; created: boolean }> {
    const existing = this.operationIds.get(idempotencyKey)
    if (existing) return { operationId: existing, created: false }
    this.operationIds.set(idempotencyKey, operationId)
    return { operationId, created: true }
  }
}
