import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { fanOutServerSide } from "../lib/server-side.server";

// App Proxy entrypoint — Shopify signs and forwards /apps/<subpath>/track here.
//   track → record the event + fan out server-side to GA4 Measurement Protocol / Meta CAPI.
export const action = async ({ request, params }) => {
  const { session } = await authenticate.public.appProxy(request);
  const shopDomain = session?.shop;
  if (!shopDomain) return new Response("Unauthorized", { status: 401 });
  if (params.type !== "track") return new Response("Not found", { status: 404 });

  const body = await request.json().catch(() => null);
  if (body) {
    await prisma.recentEvent.create({
      data: {
        shopDomain,
        name: body.event?.name ?? "event",
        platform: body.platform ?? null,
        payload: JSON.stringify(body).slice(0, 4000),
      },
    });
    // Cap the buffer to the 50 most recent per shop.
    const stale = await prisma.recentEvent.findMany({
      where: { shopDomain },
      orderBy: { createdAt: "desc" },
      skip: 50,
      select: { id: true },
    });
    if (stale.length) {
      await prisma.recentEvent.deleteMany({ where: { id: { in: stale.map((s) => s.id) } } });
    }
  }
  // Server-side fan-out: forward to GA4 Measurement Protocol / Meta CAPI.
  if (body?.event) {
    const settings = await prisma.trackingSettings.findUnique({ where: { shopDomain } });
    await fanOutServerSide(settings, body.event);
  }
  return new Response(null, { status: 204 });
};
