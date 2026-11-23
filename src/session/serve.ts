import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { KEYS, type Key } from "../core/types.js";
import type { OdrSession } from "./session.js";

// Loopback control endpoint for `odr run -- <cmd>`. The child process drives the device through
// it with a per-session bearer token; provider credentials and the private handle stay in odr.

export interface ServedSession {
  url: string;
  token: string;
  close(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1_000_000) throw new Error("body too large");
  }
  return data ? (JSON.parse(data) as Record<string, unknown>) : {};
}

const num = (v: unknown, name: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  return v;
};

export async function serveSession(session: OdrSession): Promise<ServedSession> {
  const token = randomBytes(24).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const server: Server = createServer(async (req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      res.writeHead(401).end();
      return;
    }
    try {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path === "/session") {
        const r = session.receipt();
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: session.id, provider: session.provider, device: session.device, profile: session.profile, route: r.route }));
        return;
      }
      if (req.method === "GET" && path === "/size") {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(await session.size()));
        return;
      }
      if (req.method === "GET" && path === "/screenshot") {
        const s = await session.screenshot();
        res.writeHead(200, { "content-type": "image/png", "x-input-width": String(s.input.width), "x-input-height": String(s.input.height) }).end(s.png);
        return;
      }
      if (req.method !== "POST") throw Object.assign(new Error("not found"), { status: 404 });
      const b = await body(req);
      if (path === "/tap") await session.tap(num(b.x, "x"), num(b.y, "y"), typeof b.durationMs === "number" ? { durationMs: b.durationMs } : undefined);
      else if (path === "/type") {
        if (typeof b.text !== "string") throw new Error("text must be a string");
        await session.type(b.text);
      } else if (path === "/swipe") {
        const f = b.from as Record<string, unknown>, t = b.to as Record<string, unknown>;
        await session.swipe({ x: num(f?.x, "from.x"), y: num(f?.y, "from.y") }, { x: num(t?.x, "to.x"), y: num(t?.y, "to.y") }, typeof b.durationMs === "number" ? { durationMs: b.durationMs } : undefined);
      } else if (path === "/key") {
        if (!(KEYS as readonly string[]).includes(String(b.key))) throw new Error(`key must be one of ${KEYS.join(", ")}`);
        await session.key(b.key as Key);
      } else throw Object.assign(new Error("not found"), { status: 404 });
      res.writeHead(204).end();
    } catch (error) {
      const e = error as { status?: number; code?: string; message: string };
      res.writeHead(e.status ?? 400, { "content-type": "application/json" }).end(JSON.stringify({ code: e.code ?? "error", message: e.message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
