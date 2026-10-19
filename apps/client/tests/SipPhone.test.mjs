import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSource } from "./helpers.mjs";

for (const direction of ["incoming", "outgoing"]) {
  for (const reason of [undefined, 'Q.850;cause=17;text="User busy"']) {
    test(`remote BYE: ${direction}, ${reason ?? "no Reason"}`, async () => {
      const saved = [];
      const exports = loadSource("sip/SipPhone.ts", {
        modules: {
          "sip.js": { SessionState: { Established: "Established", Terminated: "Terminated" } },
          "../api": { api: { saveCall: async (record) => saved.push(record) } }
        },
        globals: { window: { clearInterval() {}, clearTimeout() {} } }
      });
      const phone = new exports.SipPhone();
      let stateListener;
      const session = { stateChange: { addListener(listener) { stateListener = listener; } } };
      const call = {
        id: "call-1", session, direction, remote: "123",
        startedAt: new Date(Date.now() - 5000), answeredAt: new Date(Date.now() - 3000),
        persisted: false, transferAccepted: false
      };
      phone.activeCall = call;
      phone.bindSession(call);
      let accepted = 0;
      let snapshot;
      phone.subscribe((value) => { snapshot = value; });
      session.delegate.onBye({
        request: { getHeader: () => reason },
        accept: () => { accepted++; return Promise.resolve(); }
      });
      assert.equal(accepted, 1, "must acknowledge BYE rather than only recording its reason");
      stateListener("Terminated");
      stateListener("Terminated");
      await Promise.resolve();
      assert.equal(snapshot.callState, "idle");
      assert.equal(phone.activeCall, undefined);
      assert.equal(snapshot.hangupReason, reason ? "Абонент занят" : "Разговор завершён удалённой стороной");
      assert.equal(saved.length, 1);
      assert.equal(saved[0].status, "completed");
    });
  }
}
