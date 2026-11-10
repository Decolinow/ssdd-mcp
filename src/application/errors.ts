export class ApplicationError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(
    code: string,
    message: string,
    options: { readonly retryable?: boolean; readonly details?: unknown } = {},
  ) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? null;
  }
}
