import { isTransientApiError } from "../app/lib/net.server.js";

describe("isTransientApiError — retryable vs terminal", () => {
  test("the real-world Shopify 502 that killed the write-back job", () => {
    // Exactly what surfaced in the app as a permanent "Write-back failed" banner.
    const err = new Error(
      'Shopify internal error: { "networkStatusCode": 502, "message": "GraphQL Client: Bad Gateway", "response": {} }',
    );
    expect(isTransientApiError(err)).toBe(true);
  });

  test("5xx and 429 are transient, whether on the error or in its message", () => {
    expect(isTransientApiError({ networkStatusCode: 500 })).toBe(true);
    expect(isTransientApiError({ networkStatusCode: 503 })).toBe(true);
    expect(isTransientApiError({ status: 429 })).toBe(true);
    expect(isTransientApiError({ response: { status: 504 } })).toBe(true);
    expect(isTransientApiError(new Error("Service Unavailable"))).toBe(true);
    expect(isTransientApiError(new Error("Throttled"))).toBe(true);
  });

  test("network and timeout failures are transient", () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    expect(isTransientApiError(abort)).toBe(true);
    expect(isTransientApiError(new Error("fetch failed"))).toBe(true);
    expect(isTransientApiError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientApiError(new Error("socket hang up"))).toBe(true);
  });

  test("a genuine 4xx is TERMINAL — retrying forever would hide a real misconfiguration", () => {
    expect(isTransientApiError({ networkStatusCode: 400 })).toBe(false);
    expect(isTransientApiError({ networkStatusCode: 401 })).toBe(false);
    // A missing scope is the important one: it must surface, not retry silently.
    expect(isTransientApiError({ networkStatusCode: 403 })).toBe(false);
    expect(isTransientApiError({ networkStatusCode: 404 })).toBe(false);
  });

  test("an explicit status beats a misleading message", () => {
    // 400 with the word "timeout" in the body must still be terminal.
    expect(isTransientApiError({ networkStatusCode: 400, message: "timeout in field name" })).toBe(false);
  });

  test("an unrecognised error is treated as terminal, not retried blindly", () => {
    expect(isTransientApiError(new Error("Field 'foo' doesn't exist on type 'Order'"))).toBe(false);
    expect(isTransientApiError(null)).toBe(false);
    expect(isTransientApiError(undefined)).toBe(false);
  });
});
