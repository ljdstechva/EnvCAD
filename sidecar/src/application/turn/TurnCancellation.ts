const CANCELLED = Symbol('turn-cancelled')

export class TurnCancelledError extends Error {
  constructor() {
    super('Turn cancelled.')
    this.name = 'TurnCancelledError'
  }
}

export class TurnCancellation {
  private release!: () => void
  private readonly signal = new Promise<typeof CANCELLED>((resolve) => {
    this.release = () => resolve(CANCELLED)
  })
  private cancelled = false

  get requested(): boolean {
    return this.cancelled
  }

  request(): boolean {
    if (this.cancelled) return false
    this.cancelled = true
    this.release()
    return true
  }

  throwIfRequested(): void {
    if (this.cancelled) throw new TurnCancelledError()
  }

  async race<T>(operation: Promise<T>): Promise<T> {
    const result = await Promise.race([operation, this.signal])
    if (result === CANCELLED) throw new TurnCancelledError()
    return result
  }
}
