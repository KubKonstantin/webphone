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
    createOscillator() { return { frequency: {}, connect() {}, start() {}, stop() {}, disconnect() {} }; }
  }
  const { Ringtone } = loadSource("audio/Ringtone.ts", { globals: {
    Audio, AudioContext,
    window: { setInterval() { intervals++; return 1; }, clearInterval() { cleared++; }, setTimeout() { return 1; }, clearTimeout() {} }
  } });
  return { ring: new Ringtone(), players, stats: () => ({ intervals, cleared, contextClosed, streamStopped }) };
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
