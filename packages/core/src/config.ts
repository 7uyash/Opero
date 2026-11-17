import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  ENCRYPTION_KEY: z.string().min(1, "ENCRYPTION_KEY is required (32 bytes, base64)"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | undefined;

/** Validated environment configuration. Throws a readable error on misconfiguration. */
export function config(): AppConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  const problems = parsed.success ? productionProblems(process.env) : [];
  if (!parsed.success || problems.length) {
    const issues = [
      ...(parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`)),
      ...problems,
    ];
    throw new Error(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Extra rules for production, where a mistake means leaked credentials or broken links:
 * real keys, a public https APP_URL (links in emails, OAuth redirects, Secure cookies), and
 * complete provider settings when a provider is configured at all.
 */
export function productionProblems(env: NodeJS.ProcessEnv): string[] {
  if (env.NODE_ENV !== "production") return [];
  const out: string[] = [];
  const key = Buffer.from(env.ENCRYPTION_KEY ?? "", "base64");
  if (key.length !== 32) out.push("ENCRYPTION_KEY must be 32 random bytes, base64-encoded");
  if (env.SESSION_SECRET && env.SESSION_SECRET === env.ENCRYPTION_KEY) out.push("SESSION_SECRET must be different from ENCRYPTION_KEY");
  if (/changeme|example|replace/i.test(`${env.ENCRYPTION_KEY}${env.SESSION_SECRET}`)) out.push("ENCRYPTION_KEY / SESSION_SECRET still contain placeholder text");

  let url: URL | null = null;
  try {
    url = new URL(env.APP_URL ?? "");
  } catch {
    out.push("APP_URL must be the public address of the app, e.g. https://leads.example.com");
  }
  if (url && env.ALLOW_INSECURE_HTTP !== "1") {
    if (url.protocol !== "https:") out.push("APP_URL must use https:// (set ALLOW_INSECURE_HTTP=1 only for a private test install)");
    if (["localhost", "127.0.0.1"].includes(url.hostname)) out.push("APP_URL can't be localhost: it is used in emails, unsubscribe links and OAuth redirects");
  }

  const pairs: [string, string][] = [
    ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    ["META_APP_ID", "META_APP_SECRET"],
  ];
  for (const [a, b] of pairs) if (!!env[a] !== !!env[b]) out.push(`Set both ${a} and ${b}, or neither`);
  if (env.META_APP_SECRET && !env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) out.push("WHATSAPP_WEBHOOK_VERIFY_TOKEN is required when META_APP_SECRET is set");
  return out;
}

/** For tests only. */
export function resetConfigCache() {
  cached = undefined;
}
