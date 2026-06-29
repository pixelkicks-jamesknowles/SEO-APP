import { useLoaderData, useRevalidator } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, Badge, Banner, Box, ProgressBar, Divider } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { SectionHeading } from "../components/SectionHeading";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
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
  const { days, totals } = useLoaderData();
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
            No data yet. These figures populate once the app is deployed and live storefront events +
            paid orders start flowing. They don&apos;t accrue over localhost.
          </Banner>
        ) : (
          <>
            {matchRate != null && matchRate < 90 && (
              <Banner tone="warning" title={`Only ${matchRate}% of paid orders captured as purchase events`}>
                The gap is usually visitors who declined consent, or the pixel not firing on some
                checkouts. Compare with GA4, and check Consent settings on the Tracking page.
              </Banner>
            )}

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
            </InlineStack>

            <Card>
              <BlockStack gap="300">
                <SectionHeading
                  title="By day"
                  description="Paid orders vs purchase events delivered, and server-side send volume."
                />
                <Divider />
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
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
                          <td style={{ padding: "var(--p-space-150) var(--p-space-300)" }}>
                            <Text as="span" variant="bodyMd">{d.date}</Text>
                          </td>
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

            <Text as="p" tone="subdued" variant="bodySm">
              Match rate compares purchase events we delivered against paid orders Shopify reported.
              Below 100% is normal (consent, bots, sessions that didn&apos;t reach checkout tracking);
              a sudden drop is the signal to investigate.
            </Text>
          </>
        )}
      </BlockStack>
    </Page>
  );
}
