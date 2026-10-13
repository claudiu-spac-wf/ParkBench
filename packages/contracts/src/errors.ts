export class ValidationError extends Error {
  constructor(
    public readonly fields: Array<{ path: string; code: string; message?: string }>,
    message = "The request is invalid."
  ) {
    super(message);
    this.name = "ValidationError";
  }
}
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}
