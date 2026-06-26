import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { Box } from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();
  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Home
        </Link>
        <Link to="/app/tracking">Tracking</Link>
        <Link to="/app/sandbox">Event sandbox</Link>
        <Link to="/app/events">Live events</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>
      {/* Bottom breathing room below every page's content (e.g. trailing Save buttons). */}
      <Box paddingBlockEnd="800">
        <Outlet />
      </Box>
    </AppProvider>
  );
}

// Shopify needs the full ErrorBoundary + headers exports on the embedded auth boundary.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
