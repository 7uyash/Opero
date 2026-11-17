import type { IntegrationProvider } from "@lfm/db";
import type { MessageChannel } from "@lfm/shared";

/**
 * Provider adapters (ADR-012). Every external service implements this interface so the rest of
 * the app never contains provider-specific code. Status becomes CONNECTED only after `test()`
 * succeeds against the real provider.
 */

/** Error classification that drives retries (ADR-008). */
export type FailureKind = "temporary" | "permanent" | "delivery_unknown";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: FailureKind,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
  get retryable() {
    return this.kind === "temporary";
  }
}

export type OutboundMessage = {
  to: string;
  subject?: string | null;
  text: string;
  html?: string;
  /** Our message id, used for Message-ID headers / client references. */
  messageId: string;
  headers?: Record<string, string>;
  /** WhatsApp: use this approved template instead of free text (outside the 24h window). */
  providerTemplate?: { name: string; language: string; params: string[] } | null;
};

export type SendResult = { providerMessageId: string | null };

export type TestResult = { ok: true; detail?: string } | { ok: false; error: string };

export interface ChannelAdapter<Creds = unknown, Config = unknown> {
  provider: IntegrationProvider;
  channel: MessageChannel;
  /** Real provider call that proves the credentials work. */
  test(creds: Creds, config: Config): Promise<TestResult>;
  send(creds: Creds, config: Config, msg: OutboundMessage): Promise<SendResult>;
}
