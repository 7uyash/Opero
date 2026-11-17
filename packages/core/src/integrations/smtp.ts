import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { ProviderError, type ChannelAdapter, type OutboundMessage, type TestResult } from "./types";

/** Stored encrypted (ADR-009). */
export type SmtpCredentials = { username?: string; password?: string };
/** Stored in integrations.config (not secret). */
export type SmtpConfig = { host: string; port: number; secure: boolean; fromEmail: string; fromName: string; replyTo?: string };

const TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000 };

function transport(creds: SmtpCredentials, config: SmtpConfig): Transporter<SMTPTransport.SentMessageInfo> {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: !config.secure && config.port === 587,
    auth: creds.username ? { user: creds.username, pass: creds.password ?? "" } : undefined,
    ...TIMEOUTS,
  });
}

type SmtpErr = Error & { code?: string; responseCode?: number; command?: string };

/**
 * SMTP error → retry decision.
 *  - 4xx replies, connection/DNS/greeting failures before the message was handed over → temporary
 *  - 5xx replies (bad address, rejected, auth) → permanent
 *  - a timeout or dropped connection after DATA → delivery unknown (the server may have accepted it)
 */
export function classifySmtpError(err: unknown): ProviderError {
  const e = err as SmtpErr;
  const msg = e?.message ?? String(err);
  if (e?.responseCode && e.responseCode >= 500) return new ProviderError(`Email rejected: ${msg}`, "permanent", String(e.responseCode));
  if (e?.responseCode && e.responseCode >= 400) return new ProviderError(`Email server busy: ${msg}`, "temporary", String(e.responseCode));
  if (e?.code === "EAUTH") return new ProviderError("The email account rejected the username or password.", "permanent", "EAUTH");
  if (e?.code === "EENVELOPE") return new ProviderError(`Invalid recipient: ${msg}`, "permanent", "EENVELOPE");
  const networkError = ["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS", "ECONNREFUSED", "ECONNRESET", "EPROTOCOL"].includes(e?.code ?? "");
  // Once the message body has been streamed (DATA), a dropped connection means we can't know
  // whether the server queued it. Retrying blindly could send it twice.
  if (networkError && e?.command === "DATA") {
    return new ProviderError(
      "The email server stopped responding while accepting the message; it may or may not have been sent.",
      "delivery_unknown",
      e.code,
    );
  }
  if (networkError) {
    return new ProviderError(`Couldn't reach the email server (${e.code}).`, "temporary", e.code);
  }
  return new ProviderError(msg, "temporary", e?.code);
}

export const smtpAdapter: ChannelAdapter<SmtpCredentials, SmtpConfig> = {
  provider: "SMTP",
  channel: "EMAIL",

  async test(creds, config): Promise<TestResult> {
    const t = transport(creds, config);
    try {
      await t.verify();
      return { ok: true, detail: `Connected to ${config.host}:${config.port}` };
    } catch (err) {
      return { ok: false, error: classifySmtpError(err).message };
    } finally {
      t.close();
    }
  },

  async send(creds, config, msg: OutboundMessage) {
    const t = transport(creds, config);
    const domain = config.fromEmail.split("@")[1] ?? "localhost";
    try {
      const info = await t.sendMail({
        from: { name: config.fromName, address: config.fromEmail },
        to: msg.to,
        replyTo: config.replyTo || undefined,
        subject: msg.subject ?? "",
        text: msg.text,
        html: msg.html,
        messageId: `<${msg.messageId}@${domain}>`,
        headers: msg.headers,
      });
      if (info.rejected?.length) throw new ProviderError(`Recipient rejected: ${info.rejected.join(", ")}`, "permanent", "REJECTED");
      return { providerMessageId: info.messageId ?? null };
    } catch (err) {
      throw err instanceof ProviderError ? err : classifySmtpError(err);
    } finally {
      t.close();
    }
  },
};

/** Internal notification emails (team notices, invitations) use the same account. */
export async function sendSmtpSystemEmail(
  creds: SmtpCredentials,
  config: SmtpConfig,
  mail: { to: string; subject: string; text: string; html?: string },
) {
  return smtpAdapter.send(creds, config, { ...mail, messageId: `sys-${Date.now()}-${Math.random().toString(36).slice(2)}` });
}
