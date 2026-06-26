import prisma from "../db.server";

// Record per-destination server-side delivery outcomes for the health panel, capped per shop.
export async function recordDeliveries(shopDomain, results) {
  if (!results?.length) return;
  await prisma.deliveryLog.createMany({
    data: results.map((r) => ({
      shopDomain,
      destination: r.destination,
      eventName: r.eventName,
      ok: !!r.ok,
      detail: (r.detail || "").slice(0, 200) || null,
    })),
  });
  // Keep the most recent 300 per shop.
  const stale = await prisma.deliveryLog.findMany({
    where: { shopDomain },
    orderBy: { createdAt: "desc" },
    skip: 300,
    select: { id: true },
  });
  if (stale.length) {
    await prisma.deliveryLog.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
  }
}
