import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSource } from "./helpers.mjs";

const { reconcileDevices, sameOutput, setAudioOutput } = loadSource("audio/devices.ts");
const devices = [
  { kind: "audioinput", deviceId: "mic", groupId: "headset" },
  { kind: "audiooutput", deviceId: "default", groupId: "speakers" },
  { kind: "audiooutput", deviceId: "speakers", groupId: "speakers" },
  { kind: "audiooutput", deviceId: "headset", groupId: "headset" }
];
test("removed devices fall back safely; default aliases do not ring twice", () => {
  const result = reconcileDevices({ inputId: "gone", outputId: "gone", ringtoneId: "speakers" }, devices);
  assert.equal(result.inputId, "");
  assert.equal(result.outputId, "");
  assert.equal(result.ringtoneId, "");
  assert.equal(sameOutput("", "speakers", devices), true);
  assert.equal(sameOutput("headset", "speakers", devices), false);
});

test("browsers without setSinkId can still use the default output", async () => {
  await setAudioOutput({}, "");
  await assert.rejects(setAudioOutput({}, "headset"), /не поддерживает/);
});

function ringtoneSetup() {
  const players = [];
  const notes = [];
  const timers = new Map();
  let nextTimer = 0;
  let intervals = 0;
  let cleared = 0;
  let contextClosed = false;
  let streamStopped = false;
  class Audio {
    plays = 0;
    pauses = 0;
    constructor() { players.push(this); }
    async setSinkId(id) { if (id === "denied") throw new Error("denied"); this.sinkId = id; }
    async play() { this.plays++; }
    pause() { this.pauses++; }
  }
  class AudioContext {
    currentTime = 0;
    async resume() {}
    async close() { contextClosed = true; }
    createMediaStreamDestination() { return { stream: { getTracks: () => [{ stop() { streamStopped = true; } }] } }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createOscillator() {
      const oscillator = { frequency: {}, connect() {}, start(time) { notes.push({ frequency: this.frequency.value, time }); }, stop() {}, disconnect() {} };
      return oscillator;
    }
  }
  const { Ringtone } = loadSource("audio/Ringtone.ts", { globals: {
    Audio, AudioContext,
    window: { setInterval() { intervals++; return 1; }, clearInterval() { cleared++; }, setTimeout(callback, delay) { timers.set(++nextTimer, { callback, delay }); return nextTimer; }, clearTimeout(id) { timers.delete(id); } }
  } });
  return { ring: new Ringtone(), players, notes, timers, stats: () => ({ intervals, cleared, contextClosed, streamStopped }) };
}

test("ringtone routes the same stream to primary and additional speakers, then stops both", async () => {
  const { ring, players, stats } = ringtoneSetup();
  await ring.configure("headset", "speakers");
  await ring.start();
  const outputs = players.filter((player) => player.srcObject);
  assert.equal(outputs.length, 2);
  assert.equal(outputs[0].sinkId, "headset");
  assert.equal(outputs[1].sinkId, "speakers");
  assert.equal(outputs[0].srcObject, outputs[1].srcObject);
  assert.equal(outputs[0].plays, 1);
  assert.equal(outputs[1].plays, 1);
  ring.stop();
  assert.ok(outputs.every((player) => player.pauses > 0));
  ring.dispose();
  assert.equal(stats().contextClosed, true);
  assert.equal(stats().streamStopped, true);
});

test("disabled extra output never plays and cancellation during startup cannot revive ringing", async () => {
  const { ring, players, stats } = ringtoneSetup();
  await ring.configure("headset", "");
  await ring.start();
  assert.equal(players[0].plays, 1);
  assert.equal(players[1].plays, 0);
  ring.stop();
  const pending = ring.start();
  ring.stop();
  await pending;
  assert.equal(players[0].plays, 1);
  assert.equal(stats().intervals, 1);
});

test("additional output failure does not prevent primary ringtone", async () => {
  const { ring, players } = ringtoneSetup();
  await ring.configure("headset", "speakers");
  await ring.unlock();
  players.at(-1).setSinkId = async () => { throw new Error("unplugged"); };
  await assert.rejects(ring.start(), /unplugged/);
  assert.equal(players.at(-2).plays, 1);
});

test("remote hangup plays a short non-looping sound only on the primary speaker", async () => {
  const { ring, players, notes, timers, stats } = ringtoneSetup();
  await ring.configure("headset", "speakers", "melody");
  await ring.playEnded();
  const outputs = players.filter((player) => player.srcObject);
  assert.equal(outputs[0].sinkId, "headset");
  assert.equal(outputs[0].plays, 1);
  assert.equal(outputs[1].plays, 0);
  assert.deepEqual(notes.map((note) => note.frequency), [480, 350]);
  assert.equal(stats().intervals, 0);
  const stop = [...timers.values()].find((timer) => timer.delay === 700);
  assert.ok(stop);
  stop.callback();
  assert.ok(outputs[0].pauses);
});

test("all three ringtone selections produce distinct previews and preserve two-speaker routing", async () => {
  const patterns = [];
  for (const tone of ["classic", "double", "melody"]) {
    const { ring, players, notes, stats } = ringtoneSetup();
    await ring.configure("headset", "speakers", tone);
    await ring.start(true);
    patterns.push(JSON.stringify(notes));
    assert.equal(players.filter((player) => player.plays === 1).length, 2);
    assert.equal(stats().intervals, 0);
  }
  assert.equal(new Set(patterns).size, 3);
});

test("old preferences get the classic ringtone and device changes preserve the selected melody", () => {
  let stored = { inputId: "mic", outputId: "headset", ringtoneId: "speakers" };
  const { loadAudioPreferences, reconcileDevices } = loadSource("audio/devices.ts", { globals: {
    localStorage: { getItem: () => JSON.stringify(stored) }
  } });
  assert.equal(loadAudioPreferences("audio").ringtoneTone, "classic");
  stored.ringtoneTone = "invalid";
  assert.equal(loadAudioPreferences("audio").ringtoneTone, "classic");
  stored.ringtoneTone = "melody";
  const preferences = loadAudioPreferences("audio");
  assert.equal(preferences.ringtoneTone, "melody");
  assert.equal(reconcileDevices(preferences, []).ringtoneTone, "melody");
});

test("starting a new ringtone cancels an unfinished hangup sound", async () => {
  const { ring, players, stats } = ringtoneSetup();
  await ring.configure("headset", "speakers");
  const pending = ring.playEnded();
  await ring.start();
  await pending;
  assert.equal(players.filter((player) => player.plays === 1).length, 2);
  assert.equal(stats().intervals, 1);
});

test("a late hangup play promise cannot pause a newer incoming ringtone", async () => {
  const { ring, players } = ringtoneSetup();
  await ring.configure("headset", "speakers");
  await ring.unlock();
  const primary = players.find((player) => player.srcObject);
  let resolveOld;
  let plays = 0;
  primary.play = () => ++plays === 1 ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve();
  const old = ring.playEnded();
  for (let i = 0; i < 20 && !resolveOld; i++) await Promise.resolve();
  assert.ok(resolveOld);
  await ring.start();
  const pauses = primary.pauses;
  resolveOld();
  await old;
  assert.equal(primary.pauses, pauses);
});
