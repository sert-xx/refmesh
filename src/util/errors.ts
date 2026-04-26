export class RefmeshValidationError extends Error {
  readonly details: readonly string[];

  constructor(message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'RefmeshValidationError';
    this.details = details;
  }
}

export class RefmeshRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefmeshRuntimeError';
  }
}
