// CSV export of the (unattributed) orders the backfill couldn't attribute, so the merchant can inspect the
// bucket order-by-order (and hand it to their analytics/SEO team) instead of trusting an aggregate. The
// `migrated` and `source` columns are the point: they let the reader see how much of the bucket is imported
// back-catalogue (acquired on a previous platform, never had a Shopify journey) versus genuinely lost.
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const CSV_COLUMNS = [
  ["name", "Order"],
  ["date", "Date"],
  ["revenue", "Revenue"],
  ["isSubscription", "Subscription"],
  ["source", "Source"],
  ["migrated", "Migrated in"],
  ["reason", "Reason"],
  ["customerKey", "Customer id"],
  ["orderId", "Order id"],
];

// Excel/Sheets-safe: quote every field and double embedded quotes. Also neutralise a leading =/+/-/@ so a
// value like "-Order" can't be interpreted as a formula (CSV injection).
function csvCell(value) {
  if (value == null) return '""';
  let s = String(value);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const rows = await prisma.unattributedOrder
    .findMany({ where: { shopDomain: session.shop }, orderBy: { revenue: "desc" } })
    .catch(() => []);

  const header = CSV_COLUMNS.map(([, label]) => csvCell(label)).join(",");
  const body = rows
    .map((r) =>
      CSV_COLUMNS.map(([key]) => {
        if (key === "isSubscription" || key === "migrated") return csvCell(r[key] ? "yes" : "no");
        return csvCell(r[key]);
      }).join(","),
    )
    .join("\n");
  // Prepend a UTF-8 BOM so Excel renders £ and other non-ASCII correctly.
  const csv = `﻿${header}\n${body}\n`;

  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="unattributed-orders-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
