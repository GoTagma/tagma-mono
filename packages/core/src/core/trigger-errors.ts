export class TriggerBlockedError extends Error {
  readonly code = 'TRIGGER_BLOCKED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'TriggerBlockedError';
  }
}

export class TriggerTimeoutError extends Error {
  readonly code = 'TRIGGER_TIMEOUT' as const;
  constructor(message: string) {
    super(message);
    this.name = 'TriggerTimeoutError';
  }
}
