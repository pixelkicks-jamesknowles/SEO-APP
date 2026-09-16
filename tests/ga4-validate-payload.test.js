import { validateGa4Payload, sendGa4Event } from "../app/lib/server-side.server.js";

// validateGa4Payload exists to answer ONE question: does GA4 accept the session join on a real purchase?
// It is only worth anything if it validates the payload the app ACTUALLY sends. If sendGa4Event's body
// changes and this does not, the diagnostic starts blessing something that never goes out — which is worse
// than having no diagnostic, because it would look like proof.
//
// So these tests pin the two bodies against each other rather than pinning the validator's shape alone.
const SETTINGS = {
  serverSide: true,
  ga4Id: "G-TEST",
  serverSideKeys: JSON.stringify({ ga4ApiSecret: "secret" }),
};

const EVENT = {
  name: "purchase",
  params: { transaction_id: "5500001", value: 20, currency: "GBP" },
  clientId: "859437614.1787151462",
  sessionId: "1789388786",
  timestampMicros: "1789388800000000",
};

const bodyOf = (call) => JSON.parse(call[1].body);
const callTo = (fragment) => global.fetch.mock.calls.find((c) => c[0].includes(fragment));

beforeEach(() => {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ validationMessages: [] }) });
});
afterEach(() => {
  global.fetch = undefined;
});

describe("validateGa4Payload", () => {
  test("posts to the DEBUG endpoint, which validates without ingesting", async () => {
    await validateGa4Payload(SETTINGS, EVENT);
    // Critical: it must never hit /mp/collect, or running the diagnostic would create a real conversion.
    expect(callTo("/debug/mp/collect")).toBeTruthy();
    expect(callTo("google-analytics.com/mp/collect")).toBeFalsy();
  });

  test("sends a body byte-identical to what sendGa4Event would post", async () => {
    await validateGa4Payload(SETTINGS, EVENT);
    const validated = bodyOf(callTo("/debug/mp/collect"));

    global.fetch.mockClear();
    await sendGa4Event(SETTINGS, EVENT);
    const sent = bodyOf(callTo("/mp/collect"));

    expect(validated).toEqual(sent);
  });

  test("carries the session id, timestamp and engagement default — the fields under test", async () => {
    await validateGa4Payload(SETTINGS, EVENT);
    const body = bodyOf(callTo("/debug/mp/collect"));

    // Dropping any of these would hide the very thing the diagnostic was built to find.
    expect(body.client_id).toBe("859437614.1787151462");
    expect(body.events[0].params.session_id).toBe("1789388786");
    expect(body.timestamp_micros).toBe("1789388800000000");
    expect(body.events[0].params.engagement_time_msec).toBe(1);
  });

  test("returns GA4's messages verbatim rather than paraphrasing them", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ validationMessages: [{ description: "session_id is not a valid parameter" }] }),
    });
    const r = await validateGa4Payload(SETTINGS, EVENT);
    expect(r.ok).toBe(false);
    expect(r.messages).toEqual(["session_id is not a valid parameter"]);
  });

  test("never returns the api secret, which lives in the URL", async () => {
    const r = await validateGa4Payload(SETTINGS, EVENT);
    expect(JSON.stringify(r)).not.toContain("secret");
  });

  test("explains a missing measurement id or secret instead of failing opaquely", async () => {
    expect((await validateGa4Payload({ ga4Id: "" }, EVENT)).messages[0]).toMatch(/measurement ID/i);
    expect((await validateGa4Payload({ ga4Id: "G-X", serverSideKeys: "{}" }, EVENT)).messages[0]).toMatch(/secret/i);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
