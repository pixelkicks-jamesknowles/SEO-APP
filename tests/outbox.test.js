import { nextDelayMinutes, BACKOFF_MINUTES, MAX_ATTEMPTS } from "../app/lib/outbox.server.js";

describe("nextDelayMinutes (retry backoff)", () => {
  test("first retry (after the live send = attempt 1) waits the first backoff", () => {
    expect(nextDelayMinutes(1)).toBe(BACKOFF_MINUTES[0]);
  });

  test("walks the backoff schedule as attempts increase", () => {
    // attempts=1..5 map to BACKOFF_MINUTES[0..4]
    for (let a = 1; a <= BACKOFF_MINUTES.length; a++) {
      expect(nextDelayMinutes(a)).toBe(BACKOFF_MINUTES[a - 1]);
    }
  });

  test("returns null once retries are exhausted (→ dead-letter)", () => {
    expect(nextDelayMinutes(MAX_ATTEMPTS)).toBeNull();
    expect(nextDelayMinutes(MAX_ATTEMPTS + 3)).toBeNull();
  });

  test("MAX_ATTEMPTS is the original send plus one retry per backoff step", () => {
    expect(MAX_ATTEMPTS).toBe(BACKOFF_MINUTES.length + 1);
  });
});
