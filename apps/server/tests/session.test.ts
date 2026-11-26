import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { RedisStore } from "connect-redis";

Object.assign(process.env, {
  SESSION_SECRET: "test-session-secret-at-least-32-characters", CASDOOR_ENDPOINT: "https://id.test",
  CASDOOR_CLIENT_ID: "test", CASDOOR_CLIENT_SECRET: "test", CASDOOR_REDIRECT_URI: "https://phone.test/callback",
  SIP_AUTH_URL: "https://credentials.test"
});
const { sessionMiddleware } = await import("../src/session.js");

// Real express-session and RedisStore, with a shared Redis command double.
function backend() {
  const values = new Map<string, string>(); const ttls: number[] = [];
  return { values, ttls, fail: false,
    async get(key: string) { if (this.fail) throw new Error("Redis unavailable"); return values.get(key) ?? null; },
    async set(key: string, value: string, options: any) { values.set(key, value); ttls.push(options.expiration.value); },
    async expire(_key: string, ttl: number) { ttls.push(ttl); },
    async del(keys: string[]) { keys.forEach(key => values.delete(key)); }
  };
}
async function server(t: any, client: any) {
  const app = express(); app.use(sessionMiddleware(new RedisStore({ client, prefix: "test:" })));
  app.get("/login", (req, res, next) => {
    req.session.user = { login: "alice", sub: "alice", name: "Alice" };
    req.session.save(error => error ? next(error) : res.redirect("/me"));
  });
  app.get("/me", (req, res) => res.status(req.session.user ? 200 : 401).json({ user: req.session.user }));
  app.post("/logout", (req, res, next) => req.session.destroy(error => error ? next(error) : res.sendStatus(204)));
  app.use((_err: unknown, _req: any, res: any, _next: any) => res.sendStatus(503));
  const listener = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => listener.on("listening", resolve));
  t.after(() => { listener.closeAllConnections(); listener.close(); });
  return `http://127.0.0.1:${(listener.address() as any).port}`;
}

test("session created by one replica is read by another and a replacement; logout revokes all", async t => {
  const shared = backend(); const a = await server(t, shared); const b = await server(t, shared);
  const login = await fetch(a + "/login", { redirect: "manual" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  assert.equal(shared.values.size, 1, "session is saved before redirect");
  assert.equal((await fetch(b + "/me", { headers: { cookie } })).status, 200);
  const replacement = await server(t, shared);
  assert.equal((await fetch(replacement + "/me", { headers: { cookie } })).status, 200);
  await fetch(b + "/logout", { method: "POST", headers: { cookie } });
  assert.equal((await fetch(a + "/me", { headers: { cookie } })).status, 401);
});

test("activity renews browser cookie and shared-store TTL", async t => {
  t.mock.timers.enable({ apis: ["Date"] });
  const shared = backend(); const base = await server(t, shared);
  const login = await fetch(base + "/login", { redirect: "manual" });
  const original = login.headers.get("set-cookie")!;
  t.mock.timers.tick(60000);
  const response = await fetch(base + "/me", { headers: { cookie: original.split(";")[0] } });
  const renewed = response.headers.get("set-cookie")!;
  const expiry = (value: string) => Date.parse(/Expires=([^;]+)/.exec(value)![1]);
  assert.equal(expiry(renewed) - expiry(original), 60000);
  assert.equal(shared.ttls.at(-1), 8 * 60 * 60);
  assert.match(renewed, /HttpOnly/); assert.match(renewed, /SameSite=Lax/);
});

test("Redis failure is an availability error, never a new anonymous session", async t => {
  const shared = backend(); const base = await server(t, shared);
  const login = await fetch(base + "/login", { redirect: "manual" });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]; shared.fail = true;
  const response = await fetch(base + "/me", { headers: { cookie } });
  assert.equal(response.status, 503); assert.equal(response.headers.get("set-cookie"), null);
  shared.fail = false;
  assert.equal((await fetch(base + "/me", { headers: { cookie } })).status, 200);
});
