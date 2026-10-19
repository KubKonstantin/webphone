import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import * as jsx from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import * as icons from "lucide-react";
import { JSDOM } from "jsdom";
import { loadSource } from "./helpers.mjs";

function setup() {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://phone.example.test" });
  const { window } = dom;
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(window.document.getElementById("root"));
  const frames = new Map();
  let frameId = 0;
  const timers = new Map();
  let timerId = 0;
  window.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  window.setTimeout = (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; };
  window.clearTimeout = (id) => timers.delete(id);
  window.HTMLMediaElement.prototype.setSinkId = async () => {};
  const streams = [];
  const contexts = [];
  class AudioContext {
    state = "running";
    constructor() { contexts.push(this); }
    async resume() {}
    async close() { this.state = "closed"; }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 1024, getByteTimeDomainData: (data) => data.fill(140) }; }
  }
  const media = new window.EventTarget();
  media.enumerateDevices = async () => [
    { kind: "audioinput", deviceId: "mic", label: "Микрофон", groupId: "headset" },
    { kind: "audiooutput", deviceId: "default", label: "По умолчанию", groupId: "speakers" },
    { kind: "audiooutput", deviceId: "headset", label: "Гарнитура", groupId: "headset" },
    { kind: "audiooutput", deviceId: "speakers", label: "Колонки", groupId: "speakers" }
  ];
  media.getUserMedia = async () => {
    const track = { readyState: "live", stop() { this.readyState = "ended"; } };
    const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
    streams.push(stream);
    return stream;
  };
  Object.defineProperty(window.navigator, "mediaDevices", { value: media });
  const globals = { window, document: window.document, navigator: window.navigator, localStorage: window.localStorage, HTMLMediaElement: window.HTMLMediaElement, AudioContext, DOMException: window.DOMException };
  const load = (path) => loadSource(path, { globals, modules: { react: React, "react/jsx-runtime": jsx, "lucide-react": icons } });
  return { dom, window, root, load, media, streams, contexts, frames, timers };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const fakePhone = () => ({ settings: [], async setAudioPreferences(value) { this.settings.push(value); }, async testRingtone() {}, stopAudioTest() {} });

test("startup checks the microphone; signal test and unmount release every capture", async () => {
  const env = setup();
  const { AudioSetup } = env.load("components/AudioSetup.tsx");
  const phone = fakePhone();
  await act(async () => {
    env.root.render(React.createElement(React.StrictMode, null, React.createElement(AudioSetup, { phone, storageKey: "audio.alice", busy: false })));
    await flush();
  });
  assert.ok(env.streams.length > 0);
  assert.match(env.window.document.body.textContent, /Скажите несколько слов/);
  await act(async () => {
    for (let i = 0; i < 6; i++) {
      const callbacks = [...env.frames.values()];
      env.frames.clear();
      callbacks.forEach((callback) => callback());
    }
    [...env.timers.values()].filter((timer) => timer.delay === 6000).forEach((timer) => timer.callback());
    await flush();
  });
  assert.match(env.window.document.body.textContent, /Микрофон работает/);
  assert.ok(env.streams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended")));
  assert.ok(env.contexts.every((context) => context.state === "closed"));
  await act(async () => env.root.unmount());
  env.dom.window.close();
});

test("permission denial is reported without a false ready status", async () => {
  const env = setup();
  env.media.getUserMedia = async () => { throw new env.window.DOMException("denied", "NotAllowedError"); };
  const { AudioSetup } = env.load("components/AudioSetup.tsx");
  await act(async () => { env.root.render(React.createElement(AudioSetup, { phone: fakePhone(), storageKey: "audio", busy: false })); await flush(); });
  assert.match(env.window.document.body.textContent, /Разрешите доступ к микрофону/);
  assert.doesNotMatch(env.window.document.body.textContent, /Микрофон работает/);
  await act(async () => env.root.unmount());
  env.dom.window.close();
});

test("call start stops the readiness capture and disables device changes", async () => {
  const env = setup();
  const { AudioSetup } = env.load("components/AudioSetup.tsx");
  const phone = fakePhone();
  const render = (busy) => env.root.render(React.createElement(AudioSetup, { phone, storageKey: "audio", busy }));
  await act(async () => { render(false); await flush(); });
  assert.ok(env.streams.some((stream) => stream.getTracks().some((track) => track.readyState === "live")));
  await act(async () => { render(true); await flush(); });
  assert.ok(env.streams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended")));
  assert.ok([...env.window.document.querySelectorAll("select")].every((select) => select.disabled));
  await act(async () => env.root.unmount());
  env.dom.window.close();
});

test("primary and extra output choices persist; unplugging falls back and removes duplicate default", async () => {
  const env = setup();
  const { AudioSetup } = env.load("components/AudioSetup.tsx");
  const phone = fakePhone();
  await act(async () => { env.root.render(React.createElement(AudioSetup, { phone, storageKey: "audio", busy: false })); await flush(); });
  const selects = env.window.document.querySelectorAll("select");
  for (const [index, value] of [[1, "headset"], [2, "speakers"]]) {
    await act(async () => { selects[index].value = value; selects[index].dispatchEvent(new env.window.Event("change", { bubbles: true })); await flush(); });
  }
  assert.equal(phone.settings.at(-1).outputId, "headset");
  assert.equal(phone.settings.at(-1).ringtoneId, "speakers");
  assert.equal(JSON.parse(env.window.localStorage.getItem("audio")).ringtoneId, "speakers");
  const enumerate = env.media.enumerateDevices;
  env.media.enumerateDevices = async () => (await enumerate()).filter((device) => device.deviceId !== "headset");
  await act(async () => { env.media.dispatchEvent(new env.window.Event("devicechange")); await flush(); });
  assert.equal(phone.settings.at(-1).outputId, "");
  assert.equal(phone.settings.at(-1).ringtoneId, "");
  await act(async () => env.root.unmount());
  env.dom.window.close();
});

test("history copy does not redial, and clipboard failures are visible", async () => {
  const env = setup();
  const copied = [];
  Object.defineProperty(env.window.navigator, "clipboard", { value: { writeText: async (text) => copied.push(text) } });
  const { CallHistory } = env.load("components/CallHistory.tsx");
  let redials = 0;
  await act(async () => env.root.render(React.createElement(CallHistory, {
    records: [{ id: "1", remote: "123", status: "completed", direction: "incoming", startedAt: new Date().toISOString(), durationSeconds: 3 }],
    loading: false, onRedial: () => redials++
  })));
  await act(async () => { env.window.document.querySelector('[aria-label="Копировать 123"]').click(); await flush(); });
  assert.deepEqual(copied, ["123"]);
  assert.equal(redials, 0);
  env.window.navigator.clipboard.writeText = async () => { throw new Error("denied"); };
  await act(async () => { env.window.document.querySelector(".copy-button").click(); await flush(); });
  assert.match(env.window.document.querySelector(".copy-error").textContent, /Не удалось скопировать/);
  assert.equal(env.window.document.querySelectorAll("button button").length, 0);
  await act(async () => env.root.unmount());
  env.dom.window.close();
});

test("a permission prompt resolved after call start immediately releases its microphone", async () => {
  const env = setup();
  let grant;
  const capture = env.media.getUserMedia;
  env.media.getUserMedia = () => new Promise((resolve) => { grant = async () => resolve(await capture()); });
  const { AudioSetup } = env.load("components/AudioSetup.tsx");
  const phone = fakePhone();
  await act(async () => { env.root.render(React.createElement(AudioSetup, { phone, storageKey: "audio", busy: false })); await flush(); });
  await act(async () => { env.root.render(React.createElement(AudioSetup, { phone, storageKey: "audio", busy: true })); await flush(); });
  await act(async () => { await grant(); await flush(); });
  assert.ok(env.streams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended")));
  assert.doesNotMatch(env.window.document.body.textContent, /Микрофон работает/);
  await act(async () => env.root.unmount());
  env.dom.window.close();
});

test("phonebook copy preserves the selected number and does not initiate a call", async () => {
  const env = setup();
  const copied = [];
  Object.defineProperty(env.window.navigator, "clipboard", { value: { writeText: async (text) => copied.push(text) } });
  env.window.localStorage.setItem("contacts", JSON.stringify([{ id: "1", name: "Иван", number: "+79991234567" }]));
  const { PhoneBook } = env.load("components/PhoneBook.tsx");
  let calls = 0;
  await act(async () => { env.root.render(React.createElement(PhoneBook, { storageKey: "contacts", onCall: () => calls++ })); await flush(); });
  assert.equal(env.window.document.querySelector(".copy-button").getAttribute("aria-label"), "Копировать +79991234567");
  await act(async () => { env.window.document.querySelector(".copy-button").click(); await flush(); });
  assert.deepEqual(copied, ["+79991234567"]);
  assert.equal(calls, 0);
  assert.match(env.window.document.body.textContent, /Номер скопирован/);
  await act(async () => env.root.unmount());
  env.dom.window.close();
});
