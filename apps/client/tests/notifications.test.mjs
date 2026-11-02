import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSource } from "./helpers.mjs";

function setup({ permission = "default", supported = true, secure = true } = {}) {
  const created = [];
  const storage = new Map();
  let requests = 0;
  let focused = 0;
  class Notification {
    static permission = permission;
    static async requestPermission() { requests++; return this.permission = "granted"; }
    constructor(title, options) { this.title = title; this.options = options; this.closed = 0; created.push(this); }
    close() { this.closed++; }
  }
  const { CallNotifications } = loadSource("notifications/CallNotifications.ts", { globals: {
    ...(supported ? { Notification } : {}),
    window: { isSecureContext: secure, focus() { focused++; } },
    localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) }
  } });
  const notifications = new CallNotifications();
  notifications.configureUser("alice");
  return { notifications, created, Notification, storage, counts: () => ({ requests, focused }) };
}

test("incoming events never prompt for permission; enabling does, then shows one silent notification", async () => {
  const { notifications, created, counts } = setup();
  notifications.show("one", "101");
  assert.equal(counts().requests, 0);
  assert.equal(created.length, 0);
  await notifications.setEnabled(true);
  assert.equal(counts().requests, 1);
  notifications.show("one", "101");
  notifications.show("one", "101");
  assert.equal(created.length, 1);
  assert.match(created[0].options.body, /101/);
  assert.equal(created[0].options.silent, true);
  created[0].onclick();
  assert.equal(counts().focused, 1);
  assert.equal(created[0].closed, 1);
  notifications.close("one");
  assert.equal(created[0].onclick, null);
});

test("denied, unsupported and insecure contexts do not throw or emit notifications", async () => {
  for (const options of [{ permission: "denied" }, { supported: false }, { secure: false }]) {
    const { notifications, created, counts } = setup(options);
    await notifications.setEnabled(true);
    notifications.show("one", "101");
    assert.equal(created.length, 0);
    assert.equal(counts().requests, 0);
  }
});

test("notification preference is per-user; switching users and disabling close stale notifications", async () => {
  const { notifications, created, storage } = setup({ permission: "granted" });
  notifications.show("one", "101");
  await notifications.setEnabled(false);
  assert.ok(created[0].closed);
  assert.equal(storage.get("web-phone.notifications.alice"), "false");
  notifications.show("two", "102");
  assert.equal(created.length, 1);
  notifications.configureUser("bob");
  notifications.show("two", "102");
  assert.equal(created.length, 2);
  notifications.close("one");
  assert.equal(created[1].closed, 0, "a late event for the old call cannot close the new one");
  notifications.configureUser("alice");
  assert.ok(created[1].closed);
  assert.equal(notifications.getState().enabled, false);
});

test("revoking permission closes the current notification and publishes the new state", () => {
  const { notifications, created, Notification } = setup({ permission: "granted" });
  let state;
  notifications.subscribe((next) => { state = next; });
  notifications.show("one", "101");
  Notification.permission = "denied";
  notifications.refresh();
  assert.equal(state.permission, "denied");
  assert.ok(created[0].closed);
});

test("a late permission response cannot change another user's preference", async () => {
  const { notifications, Notification, storage } = setup();
  let resolve;
  Notification.requestPermission = () => new Promise((done) => { resolve = done; });
  const pending = notifications.setEnabled(true);
  notifications.configureUser("bob");
  await notifications.setEnabled(false);
  Notification.permission = "granted";
  resolve("granted");
  await pending;
  assert.equal(notifications.getState().enabled, false);
  assert.equal(storage.get("web-phone.notifications.bob"), "false");
});
