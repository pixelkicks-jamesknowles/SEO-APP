import { useLoaderData, useRevalidator } from "@remix-run/react";
import { Page, Card, BlockStack, InlineStack, Text, Banner, Divider, Badge } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { SectionHeading } from "../components/SectionHeading";
import { byFirstTouch, touchDistribution, multiTouchShare, firstVsLastShift, bySubscriptionSource } from "../lib/attribution-report";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shopDomain = session.shop;
  // Cap the scan so a very busy shop's report stays fast; newest visitors first. When a cap is hit the
  // report reflects only the most recent SCAN_CAP rows, so we flag it rather than presenting a partial
  // aggregate as if it were the whole history.
  const SCAN_CAP = 5000;
  const [visitors, customers] = await Promise.all([
    prisma.visitorAttribution.findMany({ where: { shopDomain }, orderBy: { lastSeen: "desc" }, take: SCAN_CAP }),
    prisma.customerAttribution.findMany({ where: { shopDomain }, orderBy: { updatedAt: "desc" }, take: SCAN_CAP }),
  ]);
  return {
    totalVisitors: visitors.length,
    capped: visitors.length >= SCAN_CAP || customers.length >= SCAN_CAP,
    scanCap: SCAN_CAP,
    topSources: byFirstTouch(visitors).slice(0, 15),
    touches: touchDistribution(visitors),
    multiTouch: multiTouchShare(visitors),
    shifted: firstVsLastShift(visitors),
    subSources: bySubscriptionSource(customers).slice(0, 15),
  };
};

function Stat({ title, value, sub }) {
  return (
    <div style={{ flex: "1 1 200px" }}>
      <Card>
        <BlockStack gap="200">
          <Text as="span" variant="bodySm" tone="subdued">{title}</Text>
          <Text as="span" variant="heading2xl">{value}</Text>
          {sub && <Text as="span" variant="bodySm" tone="subdued">{sub}</Text>}
        </BlockStack>
      </Card>
    </div>
  );
}

const cell = { padding: "var(--p-space-150) var(--p-space-300)" };
const th = (align = "left") => ({ ...cell, textAlign: align });
// Row-header style: left-aligned like a data cell, but a semantic <th scope="row"> for screen readers.
export const rowHead = { ...cell, textAlign: "left", fontWeight: "normal" };

function Table({ caption, head, rows }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      {caption && (
        <caption style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          {caption}
        </caption>
      )}
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={h} scope="col" style={th(i === 0 ? "left" : "right")}>
              <Text as="span" variant="bodySm" tone="subdued">{h}</Text>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{rows}</tbody>
    </table>
  );
}

export default function Attribution() {
  const { totalVisitors, topSources, touches, multiTouch, shifted, subSources, capped, scanCap } = useLoaderData();
  const revalidator = useRevalidator();
  const hasData = totalVisitors > 0;

  return (
    <Page
      title="Attribution"
      subtitle="Where your tracked visitors first came from, and how their journey builds across sessions."
      primaryAction={{ content: "Refresh", onAction: () => revalidator.revalidate() }}
    >
      <BlockStack gap="400">
        {!hasData ? (
          <Banner tone="info">
            No attribution data yet. This populates as visitors arrive with UTM-tagged links (utm_source /
            utm_medium / utm_campaign). It's captured automatically — no setup needed.
          </Banner>
        ) : (
          <>
            {capped && (
              <Banner tone="warning">
                This report reflects your most recent {scanCap.toLocaleString()} tracked visitors — older
                history isn't included in these totals.
              </Banner>
            )}
            <InlineStack gap="400" wrap>
              <Stat title="Tracked visitors" value={totalVisitors.toLocaleString()} sub="With a known first-touch source" />
              <Stat title="Multi-touch" value={multiTouch == null ? "-" : `${multiTouch}%`} sub="Returned more than once" />
              <Stat title="Journeys shifted" value={shifted.toLocaleString()} sub="First source ≠ latest source" />
            </InlineStack>

            <Card>
              <BlockStack gap="300">
                <SectionHeading title="Top first-touch sources" description="Visitors grouped by the source/medium that first brought them (never overwritten by later visits)." />
                <Divider />
                <Table
                  caption="Visitors grouped by first-touch source and medium, with visitor and touch counts"
                  head={["Source / Medium", "Visitors", "Touches"]}
                  rows={topSources.map((r) => (
                    <tr key={`${r.source}/${r.medium}`} style={{ borderTop: "1px solid var(--p-color-border-subdued)" }}>
                      <th scope="row" style={rowHead}><Text as="span" variant="bodyMd">{r.source} / {r.medium}</Text></th>
                      <td style={th("right")}><Text as="span" variant="bodyMd">{r.visitors.toLocaleString()}</Text></td>
                      <td style={th("right")}><Text as="span" variant="bodyMd" tone="subdued">{r.touches.toLocaleString()}</Text></td>
                    </tr>
                  ))}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <SectionHeading title="Touch-count distribution" description="How many UTM-tagged visits it takes before a visitor converts or drops off." />
                <Divider />
                <InlineStack gap="400" wrap>
                  {Object.entries(touches).map(([bucket, n]) => (
                    <div key={bucket} style={{ flex: "1 1 120px" }}>
                      <BlockStack gap="100">
                        <Text as="span" variant="headingLg">{n.toLocaleString()}</Text>
                        <Badge>{bucket === "1" ? "1 touch" : `${bucket} touches`}</Badge>
                      </BlockStack>
                    </div>
                  ))}
                </InlineStack>
              </BlockStack>
            </Card>

            {subSources.length > 0 && (
              <Card>
                <BlockStack gap="300">
                  <SectionHeading title="Subscription first-order sources" description="The source that won each subscription customer's first order — inherited by every recurring order (so renewals aren't mis-credited to direct)." />
                  <Divider />
                  <Table
                    caption="Subscription customers grouped by the first-order source and medium that won them"
                    head={["Source / Medium", "Customers"]}
                    rows={subSources.map((r) => (
                      <tr key={`${r.source}/${r.medium}`} style={{ borderTop: "1px solid var(--p-color-border-subdued)" }}>
                        <th scope="row" style={rowHead}><Text as="span" variant="bodyMd">{r.source} / {r.medium}</Text></th>
                        <td style={th("right")}><Text as="span" variant="bodyMd">{r.customers.toLocaleString()}</Text></td>
                      </tr>
                    ))}
                  />
                </BlockStack>
              </Card>
            )}
          </>
        )}
      </BlockStack>
    </Page>
  );
}
