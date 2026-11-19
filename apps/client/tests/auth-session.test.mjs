import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadSource } from './helpers.mjs';

for (const status of [401, 403, 503]) test(`API ${status} only asks for login on session 401`, async () => {
  const events = [];
  const { api } = loadSource('api.ts', { globals: {
    Event, window: { dispatchEvent: e => events.push(e.type) },
    fetch: async () => ({ ok: false, status, json: async () => ({ error: 'failure' }) })
  } });
  await assert.rejects(api.sipCredentials());
  assert.equal(events.length, status === 401 ? 1 : 0);
  await assert.rejects(api.me()); assert.equal(events.length, status === 401 ? 1 : 0);
});

test('401 stops SIP credential polling without ending an active call', async () => {
  let requests = 0; let timers = 0;
  class ApiError extends Error { status = 401; }
  const { SipPhone } = loadSource('sip/SipPhone.ts', {
    modules: { 'sip.js': {}, '../api': { ApiError, api: { sipCredentials: async () => { requests++; throw new ApiError('Authentication required'); } } } },
    globals: { window: { clearTimeout() {}, setTimeout() { timers++; } } }
  });
  const phone = new SipPhone(); const call = { id: 'active' }; phone.activeCall = call;
  await phone.refreshCredentials(); await phone.refreshCredentials(); phone.scheduleReconnect();
  assert.equal(requests, 1); assert.equal(timers, 0); assert.equal(phone.activeCall, call);
  assert.equal(phone.snapshot.registration, 'error');
});
