import assert from "node:assert/strict";
import { test } from "node:test";

Object.assign(process.env, {
  SESSION_SECRET: "test-session-secret-at-least-32-characters",
  CASDOOR_ENDPOINT: "https://identity.test", CASDOOR_CLIENT_ID: "test",
  CASDOOR_CLIENT_SECRET: "test", CASDOOR_REDIRECT_URI: "https://phone.test/api/auth/callback",
  SIP_AUTH_URL: "https://primary.test/credentials",
  SIP_AUTH_FALLBACK_URL: "https://secondary.test/credentials",
  SIP_AUTH_TIMEOUT_MS: "5000", SIP_AUTH_BEARER_TOKEN: "test-token"
});
const { fetchSipCredentials, SipCredentialsError } = await import("../src/sipCredentials.js");
const { config } = await import("../src/config.js");
const payload = { sipLogin: "alice", sipPassword: "secret", wssServer: "wss://pbx.test", expiresIn: 300 };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const hanging = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

test("primary success does not contact fallback and preserves POST credentials", async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    calls.push(url);
    assert.equal(options.method, "POST");
    assert.equal(options.body, JSON.stringify({ login: "alice" }));
    assert.equal((options.headers as Record<string, string>).authorization, "Bearer test-token");
    return Response.json(payload);
  });
  assert.equal((await fetchSipCredentials("alice")).sipLogin, "alice");
  assert.deepEqual(calls, [config.SIP_AUTH_URL]);
});

for (const phase of ["headers", "body"]) test(`fallback starts at 5s on ${phase} timeout, with a fresh signal`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[] = []; const signals: AbortSignal[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    calls.push(url); const signal = options.signal as AbortSignal; signals.push(signal);
    if (calls.length === 1) return phase === "headers" ? hanging(signal) : { ok: true, json: () => hanging(signal) };
    assert.equal(signal.aborted, false);
    assert.equal(options.body, JSON.stringify({ login: "alice" }));
    return Response.json(payload);
  });
  const pending = fetchSipCredentials("alice"); await flush();
  t.mock.timers.tick(4999); await flush(); assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  assert.equal((await pending).sipPassword, "secret");
  assert.deepEqual(calls, [config.SIP_AUTH_URL, config.SIP_AUTH_FALLBACK_URL]);
  assert.equal(signals[0].aborted, true);
  assert.notEqual(signals[0], signals[1]);
  // Each new operation starts at primary again.
  await fetchSipCredentials("alice"); assert.equal(calls[2], config.SIP_AUTH_URL);
});

test("both timeouts terminate with 504 after two attempts", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => { calls++; return hanging(options.signal as AbortSignal); });
  const pending = assert.rejects(fetchSipCredentials("alice"), e => e instanceof SipCredentialsError && e.status === 504);
  t.mock.timers.tick(5000); await flush(); assert.equal(calls, 2);
  t.mock.timers.tick(5000); await pending; assert.equal(calls, 2);
});

for (const status of [401, 403, 404, 500, 503]) test(`HTTP ${status} does not trigger fallback`, async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("failure", { status }); });
  await assert.rejects(fetchSipCredentials("alice"), e => e instanceof SipCredentialsError && e.status === (status < 500 ? 403 : 502));
  assert.equal(calls, 1);
});

for (const failure of ["network", "invalid-json"]) test(`${failure} does not trigger fallback`, async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; if (failure === "network") throw new TypeError("connection failed"); return new Response("not-json"); });
  await assert.rejects(fetchSipCredentials("alice")); assert.equal(calls, 1);
});

for (const fallback of [undefined, "https://primary.test/credentials"]) test(`missing or identical fallback makes one timed attempt: ${fallback}`, async t => {
  const previous = config.SIP_AUTH_FALLBACK_URL; config.SIP_AUTH_FALLBACK_URL = fallback;
  t.after(() => { config.SIP_AUTH_FALLBACK_URL = previous; });
  t.mock.timers.enable({ apis: ["setTimeout"] }); let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => { calls++; return hanging(options.signal as AbortSignal); });
  const pending = assert.rejects(fetchSipCredentials("alice"), e => e instanceof SipCredentialsError && e.status === 504);
  t.mock.timers.tick(5000); await pending; assert.equal(calls, 1);
});

test("HTTP denial remains authoritative even when reading its error body times out", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    calls++; return { ok: false, status: 403, text: () => hanging(options.signal as AbortSignal) };
  });
  const pending = assert.rejects(fetchSipCredentials("alice"), e => e instanceof SipCredentialsError && e.status === 403);
  await flush(); t.mock.timers.tick(5000); await pending; assert.equal(calls, 1);
});
