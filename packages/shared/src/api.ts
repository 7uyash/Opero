/** Standard error body returned by every API route. */
export type ApiError = {
  error: {
    code: string;
    message: string;
    /** Field-level validation messages, keyed by field path. */
    fields?: Record<string, string>;
    details?: unknown;
  };
};
