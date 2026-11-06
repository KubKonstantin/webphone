import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './helpers.mjs';

const fresh = () => ({ sipLogin: 'alice', sipPassword: 'new-password', sipDomain: 'pbx.test', wssServer: 'wss://pbx.test', iceServers: [], expiresAt: Date.now() + 300000, refreshAfter: Date.now() + 270000 });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function setup(fetchCredentials = async () => fresh()) {
  const timers = new Map(); let nextTimer = 0; let requests = 0;
  const events = new Map();
  const target = { addEventListener(name, fn) { events.set(name, fn); }, removeEventListener(name) { events.delete(name); } };
  const agents = [], registrations = [];
  class ApiError extends Error { constructor(status) { super('API failed'); this.status = status; } }
  class UserAgent {
    static makeURI(value) { return value; }
    constructor(options) { this.options = options; agents.push(this); }
    async start() {}
    async stop() { this.stopped = true; }
  }
  class Registerer {
    state = 'Initial';
    stateChange = { addListener: fn => { this.listener = fn; } };
    constructor(agent) { this.agent = agent; registrations.push(this); }
    async register() { this.sent = (this.sent ?? 0) + 1; }
    async unregister() { this.emit('Unregistered'); }
    async dispose() { this.disposed = true; this.emit('Terminated'); }
    emit(state) { this.state = state; this.listener?.(state); }
  }
  const document = { ...target, visibilityState: 'visible' };
  const { SipPhone } = loadSource('sip/SipPhone.ts', {
    modules: { 'sip.js': { UserAgent, Registerer, RegistererState: { Registered: 'Registered', Unregistered: 'Unregistered', Terminated: 'Terminated' } }, '../api': { ApiError, api: { sipCredentials: () => { requests++; return fetchCredentials(); } } } },
    globals: { document, window: { ...target, setTimeout(fn, delay) { timers.set(++nextTimer, { fn, delay }); return nextTimer; }, clearTimeout(id) { timers.delete(id); } } }
  });
  const phone = new SipPhone();
  phone.ringtone = { stop() {}, dispose() {} };
  return { phone, agents, registrations, timers, events, document, ApiError, requests: () => requests };
}

test('REGISTER success is set only by server state; rejection fetches new credentials', async () => {
  const e = setup(); await e.phone.start();
  assert.equal(e.phone.snapshot.registration, 'connecting');
  e.registrations[0].emit('Registered');
  assert.equal(e.phone.snapshot.registration, 'registered');
  e.registrations[0].emit('Unregistered');
  assert.equal(e.phone.snapshot.registration, 'offline');
  await [...e.timers.values()].find(t => t.delay === 15000).fn();
  await flush();
  assert.equal(e.requests(), 2);
  assert.equal(e.agents.length, 2);
  assert.equal(e.phone.snapshot.registration, 'connecting');
  e.registrations[0].emit('Registered');
  assert.equal(e.phone.snapshot.registration, 'connecting', 'old agent cannot overwrite state');
});

test('wake after deadline refreshes once even for concurrent resume events', async () => {
  const e = setup(); await e.phone.start();
  e.registrations[0].emit('Registered');
  e.phone.credentials.refreshAfter = Date.now() - 1;
  e.events.get('visibilitychange')(); e.events.get('online')(); e.events.get('pageshow')();
  await flush();
  assert.equal(e.requests(), 2);
  assert.equal(e.agents.length, 2);
});

test('response arriving after logout cannot recreate a SIP agent', async () => {
  let resolve;
  const e = setup(() => new Promise(r => { resolve = r; }));
  const started = e.phone.start();
  await e.phone.stop(); resolve(fresh()); await started;
  assert.equal(e.agents.length, 0);
  assert.equal(e.events.has('visibilitychange'), false);
  assert.equal(e.timers.size, 0);
});

test('refresh in an active call stops old REGISTER without stopping the dialog transport', async () => {
  const e = setup(); await e.phone.start(); e.registrations[0].emit('Registered');
  const call = { id: 'active' }; e.phone.activeCall = call;
  await e.phone.refreshCredentials();
  assert.equal(e.phone.activeCall, call);
  assert.equal(e.registrations[0].disposed, true);
  assert.equal(e.agents[0].stopped, undefined);
  assert.equal(e.phone.pendingCredentials.sipPassword, 'new-password');
});

test('expired credentials are disconnected when the credential API fails', async () => {
  let fail = false;
  const e = setup(async () => { if (fail) throw new Error('unavailable'); return fresh(); });
  await e.phone.start(); e.registrations[0].emit('Registered');
  e.phone.credentials.expiresAt = Date.now() - 1; fail = true;
  await e.phone.refreshCredentials();
  assert.equal(e.agents[0].stopped, true);
  assert.equal(e.phone.snapshot.registration, 'error');
  assert.ok([...e.timers.values()].some(t => t.delay === 15000));
});

for (const status of [401, 403]) test(`HTTP ${status} stops automatic recovery and old registration`, async () => {
  let fail = false;
  const e = setup(async () => { if (fail) throw new e.ApiError(status); return fresh(); });
  await e.phone.start(); fail = true;
  await e.phone.refreshCredentials();
  assert.equal(e.agents[0].stopped, true);
  assert.equal(e.timers.size, 0);
  e.events.get('online')(); await flush();
  assert.equal(e.requests(), 2);
});
