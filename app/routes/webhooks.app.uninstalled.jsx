import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Sessions are deleted by the framework on reinstall; clear our offline token too.
  if (session) {
    await prisma.session.deleteMany({ where: { shop } });
  }
  return new Response();
};
