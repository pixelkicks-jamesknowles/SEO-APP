import { isSessionPlausiblyLive, sendGa4Event } from "../app/lib/server-side.server.js";
import { buildOrderPurchaseEvent } from "../app/lib/subscription.js";

// A GA4 session id IS the session's start time in unix seconds, so a stale one is measurable. This matters
// because the id rides on a cart attribute written once and never refreshed: a live order was observed
// sending a session id 47 DAYS old — it equalled the client id's own first-seen timestamp, i.e. that
// visitor's very first session. GA4 will not join an event to a session that ended; it opens a fresh,
// source-less one, which is exactly what Unassigned looks like.
const HOUR = 3600;
const atMicros = (sec) => String(sec * 1e6);

describe("isSessionPlausiblyLive", () => {
  const started = 1_785_582_509;

  test("keeps a session id that could still belong to a live session", () => {
    // GA4 ends a session after 30 minutes of INACTIVITY, not 30 from its start. An hour-old id on a shopper
    // who browsed then bought is legitimate, and dropping it would throw away a join that works — the only
    // way this guard can do harm.
    expect(isSessionPlausiblyLive(started, atMicros(started + 60))).toBe(true);
    expect(isSessionPlausiblyLive(started, atMicros(started + HOUR))).toBe(true);
    expect(isSessionPlausiblyLive(started, atMicros(started + 3 * HOUR))).toBe(true);
  });

  test("drops an id no living session could own", () => {
    expect(isSessionPlausiblyLive(started, atMicros(started + 5 * HOUR))).toBe(false);
    // The real case: 47 days.
    expect(isSessionPlausiblyLive(started, atMicros(started + 47 * 24 * HOUR))).toBe(false);
  });

  test("a malformed or missing id is never sent", () => {
    expect(isSessionPlausiblyLive(null, atMicros(started))).toBe(false);
    expect(isSessionPlausiblyLive("not-a-number", atMicros(started))).toBe(false);
    expect(isSessionPlausiblyLive(0, atMicros(started))).toBe(false);
  });

  test("keeps the id when age cannot be judged, rather than guessing it away", () => {
    // No timestamp at all means the event is being sent now, so measure against now.
    expect(isSessionPlausiblyLive(Math.floor(Date.now() / 1000), undefined)).toBe(true);
    // Clock skew makes the event look earlier than its session. Trust it: dropping costs a working join.
    expect(isSessionPlausiblyLive(started, atMicros(started - HOUR))).toBe(true);
  });
});

describe("sendGa4Event omits a dead session id", () => {
  const SETTINGS = { serverSide: true, ga4Id: "G-TEST", serverSideKeys: JSON.stringify({ ga4ApiSecret: "s" }) };
  const started = 1_785_582_509;
  const body = () => JSON.parse(global.fetch.mock.calls[0][1].body);

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    global.fetch = undefined;
  });

  test("a fresh session id is still sent", async () => {
    await sendGa4Event(SETTINGS, {
      name: "purchase",
      params: { transaction_id: "1" },
      clientId: "1.2",
      sessionId: String(started),
      timestampMicros: atMicros(started + 600),
    });
    expect(body().events[0].params.session_id).toBe(String(started));
  });

  test("a 47-day-old one is dropped entirely, not sent as a dead join", async () => {
    await sendGa4Event(SETTINGS, {
      name: "purchase",
      params: { transaction_id: "1" },
      clientId: "1.2",
      sessionId: String(started),
      timestampMicros: atMicros(started + 47 * 24 * HOUR),
    });
    // Absent, not empty-string or null: GA4 must be left to open its own session rather than handed a
    // reference to one that no longer exists.
    expect(body().events[0].params).not.toHaveProperty("session_id");
    // Everything else still goes.
    expect(body().events[0].params.transaction_id).toBe("1");
    expect(body().client_id).toBe("1.2");
  });
});

describe("attribution rides on the event, not the session", () => {
  test("the purchase carries GA4's native campaign_* names as well as the generic ones", () => {
    // The generic names are inert custom parameters to GA4. campaign_source / campaign_medium /
    // campaign_name are what its own traffic-source attribution reads, and unlike the session join they do
    // not depend on a session still being alive.
    const ev = buildOrderPurchaseEvent(
      { id: 1, current_total_price: "10.00", currency: "GBP", line_items: [] },
      { attribution: { source: "google", medium: "cpc", campaign: "spring" } },
    );
    expect(ev.params).toMatchObject({
      source: "google",
      medium: "cpc",
      campaign: "spring",
      campaign_source: "google",
      campaign_medium: "cpc",
      campaign_name: "spring",
    });
  });

  test("no attribution means no campaign params invented", () => {
    const ev = buildOrderPurchaseEvent({ id: 1, current_total_price: "10.00", currency: "GBP", line_items: [] }, {});
    expect(ev.params).not.toHaveProperty("campaign_source");
  });
});
