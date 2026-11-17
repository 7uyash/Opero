import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Test-only stand-in for provider HTTP APIs (Graph, Gmail, HubSpot). The production adapters are
 * pointed at it through their base-URL env vars, so the real request/response code is exercised.
 */
export type FakeRequest = { method: string; path: string; query: URLSearchParams; headers: IncomingMessage["headers"]; body: string; json: any };
export type FakeHandler = (req: FakeRequest) => { status?: number; json?: unknown } | Promise<{ status?: number; json?: unknown }>;

export class FakeProvider {
  private server!: Server;
  private routes = new Map<string, FakeHandler>();
  calls: FakeRequest[] = [];
  url = "";

  async start() {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString();
      const u = new URL(req.url ?? "/", "http://x");
      let json: unknown = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {
        json = Object.fromEntries(new URLSearchParams(body));
      }
      const fr: FakeRequest = { method: req.method ?? "GET", path: u.pathname, query: u.searchParams, headers: req.headers, body, json };
      this.calls.push(fr);
      const handler = this.match(fr);
      const out = handler ? await handler(fr) : { status: 404, json: { error: { message: `No fake route for ${fr.method} ${fr.path}` } } };
      res.writeHead(out.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.json ?? {}));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  /** Route patterns: "POST /v23.0/123/messages"; ":id" matches one path segment. */
  on(pattern: string, handler: FakeHandler) {
    this.routes.set(pattern, handler);
    return this;
  }

  reset() {
    this.routes.clear();
    this.calls = [];
  }

  callsTo(method: string, pathPart: string) {
    return this.calls.filter((c) => c.method === method && c.path.includes(pathPart));
  }

  private match(r: FakeRequest): FakeHandler | undefined {
    for (const [pattern, h] of this.routes) {
      const [m, p] = pattern.split(" ");
      if (m !== r.method) continue;
      const re = new RegExp(`^${p!.replace(/:[a-zA-Z]+/g, "[^/]+")}$`);
      if (re.test(r.path)) return h;
    }
    return undefined;
  }

  async stop() {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
