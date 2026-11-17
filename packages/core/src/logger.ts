import pino from "pino";

/** Structured JSON logger with secret redaction (ADR-013). */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
  base: { service: process.env.SERVICE_NAME ?? "lfm" },
  redact: {
    paths: [
      "password",
      "*.password",
      "passwordHash",
      "*.passwordHash",
      "token",
      "*.token",
      "accessToken",
      "*.accessToken",
      "refreshToken",
      "*.refreshToken",
      "credentials",
      "*.credentials",
      "headers.authorization",
      "headers.cookie",
    ],
    censor: "[redacted]",
  },
});
