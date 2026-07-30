import { redirect } from "@remix-run/node";
import { authenticate } from "../shopify.server";

// The Event sandbox has been merged into Developer tools (/app/datalayer) as the "Event preview" section.
// This route just redirects, so any old links (Help, dashboard, bookmarks) still land in the right place.
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return redirect("/app/datalayer");
};
