export type ErrorCode =
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "limit_exceeded"
  | "brain_closed"
  | "idempotency_mismatch"
  | "insufficient_scope";

/** An expected error returned to the agent with enough detail to recover. */
export class BrainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "BrainError";
  }

  toJSON(): Record<string, unknown> {
    return { error: { code: this.code, message: this.message, ...this.details } };
  }
}
