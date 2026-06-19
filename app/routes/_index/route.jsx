import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { login } from "../../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 640, margin: "4rem auto" }}>
      <h1>Pixelify SEO + Tracking</h1>
      <p>Deterministic SEO, validated structured data, and consent-gated tracking.</p>
      {showForm && (
        <Form method="post" action="/auth/login">
          <label>
            Shop domain
            <input type="text" name="shop" placeholder="my-shop.myshopify.com" />
          </label>
          <button type="submit">Install</button>
        </Form>
      )}
    </div>
  );
}
