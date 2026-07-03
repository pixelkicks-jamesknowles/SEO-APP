import { useLoaderData, useRevalidator } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, Badge, Banner, ProgressBar, Divider } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { computeHealth } from "../lib/health.server";
import { getMatchQuality } from "../lib/delivery.server";
import { SectionHeading } from "../components/SectionHeading";

// Human labels for the Meta identifier columns, ordered by match-quality impact (email/phone move EMQ
// the most). Reconciliation-backfilled purchases carry no browser cookies, so fbp/fbc read lower — the
// copy explains that.
const ID_LABELS = [
  ["em", "Email"], ["ph", "Phone"], ["fn", "First name"], ["ln", "Last name"],
  ["ct", "City"], ["st", "State"], ["zp", "Zip"], ["country", "Country"],
  ["externalId", "Customer ID"], ["fbp", "Meta browser ID (fbp)"], ["fbc", "Meta click ID (fbc)"],
  ["clientIp", "IP address"], ["userAgent", "User agent"],
];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const health = await computeHealth(session.shop);
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const rows = await prisma.trackingDaily.findMany({
    where: { shopDomain: session.shop, date: { gte: since } },
    orderBy: { date: "desc" },
  });
  const sum = (k) => rows.reduce((t, r) => t + (r[k] || 0), 0);
  return {
    days: rows.map((r) => ({
      date: r.date,
      ordersPaid: r.ordersPaid,
      purchasesDelivered: r.purchasesDelivered,
      eventsSent: r.eventsSent,
      eventsFailed: r.eventsFailed,
    })),
    totals: {
      ordersPaid: sum("ordersPaid"),
      purchasesDelivered: sum("purchasesDelivered"),
      eventsSent: sum("eventsSent"),
      eventsFailed: sum("eventsFailed"),
    },
    alerts: health.alerts,
    outboxPending: health.outboxPending,
    outboxDead: health.outboxDead,
    matchQuality: await getMatchQuality(session.shop, 30),
  };
};

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null);

function Stat({ title, value, sub, progress, tone }) {
  return (
    <div style={{ flex: "1 1 220px" }}>
      <Card>
        <BlockStack gap="200">
          <Text as="span" variant="bodySm" tone="subdued">{title}</Text>
          <Text as="span" variant="heading2xl">{value}</Text>
          {progress != null && <ProgressBar progress={Math.min(100, progress)} tone={tone} size="small" />}
          {sub && <Text as="span" variant="bodySm" tone="subdued">{sub}</Text>}
        </BlockStack>
      </Card>
    </div>
  );
}

export default function Accuracy() {
  const { days, totals, alerts, outboxPending, outboxDead, matchQuality } = useLoaderData();
  const revalidator = useRevalidator();
  const matchRate = pct(totals.purchasesDelivered, totals.ordersPaid);
  const sends = totals.eventsSent + totals.eventsFailed;
  const deliveryRate = pct(totals.eventsSent, sends);
  const hasData = totals.ordersPaid > 0 || sends > 0;

  return (
    <Page
      title="Accuracy"
      subtitle="How completely your store's purchases and events are being captured and delivered (last 30 days)."
      primaryAction={{ content: "Refresh", onAction: () => revalidator.revalidate() }}
    >
      <BlockStack gap="400">
        {!hasData ? (
          <Banner tone="info">
            No data yet. These figures populate as paid orders and storefront events start flowing.
            Browse and place a test order on your storefront to see them appear.
          </Banner>
        ) : (
          <>
            {alerts.map((a) => (
              <Banner key={a.kind} tone={a.severity === "critical" ? "critical" : "warning"} title={a.title}>
                {a.body}
              </Banner>
            ))}

            <InlineStack gap="400" wrap>
              <Stat
                title="Purchase capture (30d)"
                value={matchRate == null ? "-" : `${matchRate}%`}
                sub={`${totals.purchasesDelivered} purchase events / ${totals.ordersPaid} paid orders`}
                progress={matchRate ?? 0}
                tone={matchRate != null && matchRate < 90 ? "critical" : "success"}
              />
              <Stat
                title="Delivery success (30d)"
                value={deliveryRate == null ? "-" : `${deliveryRate}%`}
                sub={`${totals.eventsSent} delivered / ${totals.eventsFailed} failed`}
                progress={deliveryRate ?? 0}
                tone={deliveryRate != null && deliveryRate < 98 ? "critical" : "success"}
              />
              <Stat title="Events sent (30d)" value={totals.eventsSent.toLocaleString()} sub="Server-side deliveries" />
              <Stat
                title="Retry queue"
                value={(outboxPending || 0).toLocaleString()}
                sub={outboxDead > 0 ? `${outboxDead} gave up after retries` : "Failed sends awaiting retry"}
                tone={outboxDead > 0 ? "critical" : undefined}
              />
            </InlineStack>

            <Card>
              <BlockStack gap="300">
                <SectionHeading
                  title="By day"
                  description="Paid orders vs purchase events delivered, and server-side send volume."
                />
                <Divider />
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <caption style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
                    Daily paid orders, purchase events delivered, match rate and server-side send volume (last 30 days)
                  </caption>
                  <thead>
                    <tr>
                      {["Date", "Orders", "Purchases", "Match", "Sent", "Failed"].map((h) => (
                        <th key={h} scope="col" style={{ textAlign: h === "Date" ? "left" : "right", padding: "var(--p-space-150) var(--p-space-300)" }}>
                          <Text as="span" variant="bodySm" tone="subdued">{h}</Text>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {days.map((d) => {
                      const m = pct(d.purchasesDelivered, d.ordersPaid);
                      return (
                        <tr key={d.date} style={{ borderTop: "1px solid var(--p-color-border-subdued)" }}>
                          <th scope="row" style={{ textAlign: "left", fontWeight: "normal", padding: "var(--p-space-150) var(--p-space-300)" }}>
                            <Text as="span" variant="bodyMd">{d.date}</Text>
                          </th>
                          <td style={{ textAlign: "right", padding: "var(--p-space-150) var(--p-space-300)" }}>{d.ordersPaid}</td>
                          <td style={{ textAlign: "right", padding: "var(--p-space-150) var(--p-space-300)" }}>{d.purchasesDelivered}</td>
                          <td style={{ textAlign: "right", padding: "var(--p-space-150) var(--p-space-300)" }}>
                            {m == null ? "-" : <Badge tone={m < 90 ? "warning" : "success"}>{`${m}%`}</Badge>}
                          </td>
                          <td style={{ textAlign: "right", padding: "var(--p-space-150) var(--p-space-300)" }}>{d.eventsSent}</td>
                          <td style={{ textAlign: "right", padding: "var(--p-space-150) var(--p-space-300)" }}>
                            {d.eventsFailed > 0 ? <Text as="span" tone="critical">{d.eventsFailed}</Text> : 0}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <SectionHeading
                  title="Meta match quality (30d)"
                  description="Meta's Event Match Quality is driven by how many identifiers each purchase carries. Higher coverage = more conversions attributed. Email and phone move it the most; capture them at checkout to lift the low ones."
                />
                <Divider />
                {matchQuality.purchases === 0 ? (
                  <Text as="p" tone="subdued" variant="bodySm">No purchases recorded yet in the last 30 days.</Text>
                ) : (
                  <BlockStack gap="200">
                    <Text as="span" variant="bodySm" tone="subdued">Across {matchQuality.purchases.toLocaleString()} purchase{matchQuality.purchases === 1 ? "" : "s"}:</Text>
                    {ID_LABELS.map(([col, label]) => {
                      const cov = matchQuality.coverage[col] ?? 0;
                      return (
                        <InlineStack key={col} gap="300" blockAlign="center" wrap={false}>
                          <div style={{ width: 160 }}><Text as="span" variant="bodySm">{label}</Text></div>
                          <div style={{ flex: 1 }}><ProgressBar progress={cov} tone={cov >= 70 ? "success" : cov >= 30 ? "highlight" : "critical"} size="small" /></div>
                          <div style={{ width: 44, textAlign: "right" }}><Text as="span" variant="bodySm" tone="subdued">{cov}%</Text></div>
                        </InlineStack>
                      );
                    })}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>

            <Text as="p" tone="subdued" variant="bodySm">
              Match rate compares purchase events we delivered against paid orders Shopify reported.
              Below 100% is normal (consent, bots, sessions that didn&apos;t reach checkout tracking);
              a sudden drop is the signal to investigate. Missed purchases are automatically backfilled
              server-side within about 20 minutes (reconciliation), so this should trend toward 100%.
            </Text>
          </>
        )}
      </BlockStack>
    </Page>
  );
}
