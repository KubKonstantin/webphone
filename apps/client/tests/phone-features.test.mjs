import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSource } from "./helpers.mjs";

const SessionState = { Initial: "Initial", Establishing: "Establishing", Established: "Established", Terminating: "Terminating", Terminated: "Terminated" };
class FakeStream {
  tracks = [];
  addTrack(track) { this.tracks.push(track); }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
}
class Invitation {
  state = SessionState.Initial;
  remoteIdentity = { uri: { user: "101" } };
  rejected = [];
  stateChange = { addListener: (listener) => { this.listener = listener; } };
  async reject(options) { this.rejected.push(options); this.listener?.(SessionState.Terminated); }
}
class Inviter extends Invitation {
  constructor(ua, target, options) { super(); this.options = options; this.target = target; }
  async invite(options) { this.inviteOptions = options; this.state = SessionState.Establishing; this.listener(this.state); }
}
function setup() {
  const records = [];
  const storage = new Map();
  const { SipPhone } = loadSource("sip/SipPhone.ts", {
    modules: {
      "sip.js": { SessionState, Invitation, Inviter, UserAgent: { makeURI: (value) => value } },
      "../api": { api: { saveCall: async (record) => records.push(record) } }
    },
    globals: {
      MediaStream: FakeStream, crypto: { randomUUID: () => "call-1" },
      localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      window: { clearInterval() {}, clearTimeout() {} }
    }
  });
  const phone = new SipPhone();
  let ringtoneStarts = 0;
  phone.ringtone = { stop() {}, start() { ringtoneStarts++; return Promise.resolve(); }, async configure() {} };
  return { phone, records, storage, ringtoneStarts: () => ringtoneStarts };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test("DND rejects incoming calls with 486, logs them, and does not disturb an active call", async () => {
  const { phone, records, ringtoneStarts } = setup();
  phone.setDnd(true);
  const current = { id: "existing" };
  phone.activeCall = current;
  const invitation = new Invitation();
  phone.handleIncoming(invitation);
  await flush();
  assert.equal(invitation.rejected[0].statusCode, 486);
  assert.equal(ringtoneStarts(), 0);
  assert.equal(records[0].status, "rejected");
  assert.equal(records[0].remote, "101");
  assert.equal(phone.activeCall, current);
});

test("DND is scoped to the user, persists, and can be disabled", () => {
  const { phone, storage } = setup();
  phone.configureUser("alice");
  phone.setDnd(true);
  assert.equal(storage.get("web-phone.dnd.alice"), "true");
  phone.configureUser("bob");
  assert.equal(phone.snapshot.dnd, false);
  phone.configureUser("alice");
  assert.equal(phone.snapshot.dnd, true);
  phone.setDnd(false);
  assert.equal(storage.get("web-phone.dnd.alice"), "false");
});

test("enabling DND while ringing stops and rejects the pending call", async () => {
  const { phone, records } = setup();
  const invitation = new Invitation();
  phone.handleIncoming(invitation);
  phone.setDnd(true);
  await flush();
  assert.equal(invitation.rejected[0].statusCode, 486);
  assert.equal(phone.activeCall, undefined);
  assert.equal(phone.snapshot.callState, "idle");
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "rejected");
});

test("183 and track events play early media before answer; DND still allows outgoing calls", async () => {
  const { phone, records } = setup();
  phone.userAgent = {};
  phone.credentials = { sipDomain: "example.test" };
  phone.update({ registration: "registered", dnd: true });
  const audio = { volume: 1, srcObject: null, plays: 0, async play() { this.plays++; }, pause() {} };
  phone.setRemoteAudioElement(audio);
  await phone.setAudioPreferences({ inputId: "usb-mic", outputId: "", ringtoneId: "" });
  await phone.call("200");
  const call = phone.activeCall;
  const session = call.session;
  assert.equal(session.options.earlyMedia, true);
  assert.equal(session.options.sessionDescriptionHandlerOptions.constraints.audio.deviceId.exact, "usb-mic");
  const track = { kind: "audio" };
  let onTrack;
  let removed = false;
  const pc = {
    getReceivers: () => [{ track }],
    addEventListener: (type, listener) => { assert.equal(type, "track"); onTrack = listener; },
    removeEventListener: () => { removed = true; }
  };
  session.sessionDescriptionHandler = { peerConnection: pc };
  session.delegate.onSessionDescriptionHandler(session.sessionDescriptionHandler);
  session.inviteOptions.requestDelegate.onProgress({ message: { statusCode: 180 } });
  assert.equal(audio.plays, 0);
  session.inviteOptions.requestDelegate.onProgress({ message: { statusCode: 183 } });
  assert.equal(audio.plays, 1);
  assert.equal(audio.srcObject.getAudioTracks().length, 1);
  assert.equal(call.answeredAt, undefined);
  assert.notEqual(phone.snapshot.callState, "active");
  onTrack();
  assert.equal(audio.srcObject.getAudioTracks().length, 1, "do not duplicate tracks on repeated progress");
  session.listener(SessionState.Established);
  assert.equal(phone.snapshot.callState, "active");
  assert.ok(call.answeredAt);
  session.listener(SessionState.Terminated);
  await flush();
  assert.equal(audio.srcObject, null);
  assert.equal(removed, true);
  assert.equal(records[0].status, "completed");
  const plays = audio.plays;
  onTrack();
  assert.equal(audio.plays, plays, "late tracks must not restart audio after hangup");
});

test("failed output selection rolls back the conversation and ringtone routes", async () => {
  const { phone } = setup();
  const selected = [];
  phone.remoteAudio = { async setSinkId(id) { selected.push(id); } };
  phone.audioPreferences = { inputId: "", outputId: "old", ringtoneId: "" };
  phone.ringtone.configure = async (id) => { if (id === "new") throw new Error("Device denied"); };
  await assert.rejects(phone.setAudioPreferences({ inputId: "", outputId: "new", ringtoneId: "extra" }));
  assert.deepEqual(selected, ["old"]);
  assert.equal(phone.audioPreferences.outputId, "old");
});
