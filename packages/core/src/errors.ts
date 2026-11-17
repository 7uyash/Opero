/** Domain error with a stable machine code and an HTTP status hint. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly fields?: Record<string, string>,
    /** Extra machine-readable context returned to the client (never secrets). */
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  unauthenticated: () => new AppError("UNAUTHENTICATED", "Please sign in to continue.", 401),
  forbidden: (msg = "You don't have permission to do that.") => new AppError("FORBIDDEN", msg, 403),
  notFound: (what = "Record") => new AppError("NOT_FOUND", `${what} not found.`, 404),
  conflict: (msg: string, fields?: Record<string, string>) => new AppError("CONFLICT", msg, 409, fields),
  validation: (msg: string, fields?: Record<string, string>) => new AppError("VALIDATION_FAILED", msg, 422, fields),
  rateLimited: () => new AppError("RATE_LIMITED", "Too many attempts. Please wait a moment and try again.", 429),
};
