import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { loadSource } from './helpers.mjs';

function setup(path = '/') {
  const dom = new JSDOM('<div id="root"></div>', { url: `https://phone.test${path}` });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let consumer;
  window.launchQueue = { setConsumer(value) { consumer = value; } };
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const globals = { window, URL, URLSearchParams, sessionStorage: window.sessionStorage };
  const load = (entry) => loadSource(entry, { globals, modules: { react: React } });
  return { window, load, launch: url => consumer({ targetURL: url }), close: () => dom.window.close() };
}

test('SIP parser accepts numbers and addresses, rejecting malformed or parameterized links', () => {
  const e = setup();
  const { parseSipLink, readSipLaunch, sipLoginUrl } = e.load('pwa/sipLinks.ts');
  assert.equal(parseSipLink('sip:+79991234567'), '+79991234567');
  assert.equal(parseSipLink('SIP:alice@PBX.example:5060'), 'sip:alice@pbx.example:5060');
  for (const bad of ['tel:123', 'sip:', 'sip:%ZZ', 'sip:123?body=x', 'sip:a:b@host', 'sip:a@host;transport=tcp', 'sip:a@host:65536', 'sip:a@-host', 'sip:%0a123']) assert.equal(parseSipLink(bad), undefined, bad);
  const launch = 'https://phone.test/?sip=' + encodeURIComponent('sip:+79991234567');
  assert.equal(readSipLaunch(launch, 'https://phone.test').target, '+79991234567');
  assert.equal(readSipLaunch('https://other.test/?sip=sip:123', 'https://phone.test').kind, 'none');
  assert.equal(readSipLaunch('/?sip=sip:123&sip=sip:456', 'https://phone.test').kind, 'invalid');
  const login = new URL(sipLoginUrl('+79991234567'), 'https://phone.test');
  const returnTo = login.searchParams.get('returnTo');
  assert.ok(returnTo.startsWith('/?'));
  assert.equal(readSipLaunch(returnTo, 'https://phone.test').target, '+79991234567');
  e.close();
});

test('pending SIP storage validates expiry and contents', () => {
  const e = setup();
  const api = e.load('pwa/sipLinks.ts');
  api.savePendingSip('123');
  assert.equal(api.restorePendingSip(), '123');
  e.window.sessionStorage.setItem('web-phone.pending-sip-link', JSON.stringify({ uri: 'sip:456', expires: Date.now() - 1 }));
  assert.equal(api.restorePendingSip(), undefined);
  assert.equal(e.window.sessionStorage.length, 0);
  e.window.sessionStorage.setItem('web-phone.pending-sip-link', '{broken');
  assert.equal(api.restorePendingSip(), undefined);
  e.close();
});

test('SIP link survives login, defers during a call, and processes later launches without navigation', async () => {
  const e = setup('/?sip=sip%3A123');
  const { useSipLinks } = e.load('pwa/useSipLinks.ts');
  const root = createRoot(e.window.document.getElementById('root'));
  let state;
  const targets = [];
  const setDestination = target => targets.push(target);
  function Harness({ auth, busy }) { state = useSipLinks(auth, busy, setDestination); return null; }
  const render = async (auth, busy) => act(async () => root.render(React.createElement(React.StrictMode, null, React.createElement(Harness, { auth, busy }))));
  await render(false, false);
  assert.equal(state.pending, '123');
  assert.match(state.loginUrl, /returnTo=/);
  assert.equal(e.window.location.search, '');
  assert.equal(targets.length, 0);
  await render(true, true);
  assert.equal(targets.length, 0);
  await render(true, false);
  assert.deepEqual(targets, ['123']);
  await act(async () => e.launch('https://phone.test/?sip=sip%3A123'));
  assert.deepEqual(targets, ['123']); // initial launch echo
  await render(true, true);
  await act(async () => e.launch('https://phone.test/?sip=sip%3A456'));
  assert.equal(state.pending, '456');
  assert.deepEqual(targets, ['123']);
  await render(true, false);
  assert.deepEqual(targets, ['123', '456']);
  assert.equal(e.window.location.search, '');
  await act(async () => e.launch('https://phone.test/?sip=javascript%3Aalert(1)'));
  assert.match(state.message, /Некорректная/);
  await act(async () => root.unmount());
  e.close();
});

test('installation prompts only on action and provides a menu fallback', async () => {
  const e = setup();
  const { useAppInstall } = e.load('pwa/useAppInstall.ts');
  const root = createRoot(e.window.document.getElementById('root'));
  let state;
  function Harness() { state = useAppInstall(); return null; }
  await act(async () => root.render(React.createElement(Harness)));
  await act(async () => state.install());
  assert.ok(state.message);
  let prompted = 0;
  const event = new e.window.Event('beforeinstallprompt', { cancelable: true });
  event.prompt = async () => { prompted++; };
  event.userChoice = Promise.resolve({ outcome: 'dismissed' });
  await act(async () => e.window.dispatchEvent(event));
  assert.equal(event.defaultPrevented, true);
  assert.equal(state.available, true);
  assert.equal(prompted, 0);
  await act(async () => state.install());
  assert.equal(prompted, 1);
  assert.equal(state.available, false);
  assert.equal(state.pending, false);
  await act(async () => e.window.dispatchEvent(new e.window.Event('appinstalled')));
  assert.equal(state.installed, true);
  await act(async () => root.unmount());
  e.close();
});

test('manifest includes SIP registration, existing-window launch and correctly sized PNG icons', () => {
  const publicDir = new URL('../public/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', publicDir)));
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.launch_handler.client_mode, 'focus-existing');
  assert.deepEqual(manifest.protocol_handlers, [{ protocol: 'sip', url: '/?sip=%s' }]);
  for (const icon of manifest.icons) {
    const png = readFileSync(new URL(icon.src.slice(1), publicDir));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
  }
});
