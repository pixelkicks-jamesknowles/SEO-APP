// Strip personally-identifiable fields from an event before it's stored (e.g. the Live-events
// debug buffer). PII is still used in transit for delivery (and hashed before it reaches Meta) -
// this only ensures nothing identifiable is persisted at rest. Pure (unit-tested).

const PII_TOP = ["email", "phone", "externalId", "clientIp", "fbp", "fbc", "userAgent"];
const PII_CHECKOUT = ["email", "phone", "shippingAddress", "billingAddress"];

export function redactEvent(event) {
  if (!event || typeof event !== "object") return event;
  const out = { ...event };
  for (const k of PII_TOP) delete out[k];
  if (out.data && typeof out.data === "object") {
    out.data = { ...out.data };
    if (out.data.checkout && typeof out.data.checkout === "object") {
      out.data.checkout = { ...out.data.checkout };
      for (const k of PII_CHECKOUT) delete out.data.checkout[k];
    }
  }
  return out;
}
