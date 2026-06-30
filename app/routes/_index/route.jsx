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

const FEATURES = [
  ["Server-side delivery", "Events go straight to GA4, Meta and GTM from the server, so they survive ad blockers, ITP and the checkout sandbox."],
  ["Subscriptions & refunds", "Recurring orders and refunds tracked properly, with first-order attribution carried across sessions."],
  ["Consent-ready", "Google Consent Mode v2, bot filtering and event deduplication built in."],
];

export default function App() {
  const { showForm } = useLoaderData();
  return (
    <main className="pk">
      <style>{CSS}</style>
      <div className="pk-card">
        <div className="pk-mark" aria-hidden="true">PK</div>
        <h1 className="pk-title">Pixel Kicks Tracking</h1>
        <p className="pk-tag">
          Accurate server-side conversion tracking for Shopify. GA4, Meta and GTM, with no theme code.
        </p>

        {showForm && (
          <Form className="pk-form" method="post" action="/auth/login">
            <label className="pk-label" htmlFor="shop">Install on your store</label>
            <div className="pk-row">
              <input className="pk-input" id="shop" type="text" name="shop" placeholder="your-store.myshopify.com" />
              <button className="pk-btn" type="submit">Install</button>
            </div>
            <span className="pk-hint">Enter your myshopify.com domain to begin.</span>
          </Form>
        )}

        <ul className="pk-features">
          {FEATURES.map(([title, body]) => (
            <li key={title} className="pk-feature">
              <span className="pk-feature-title">{title}</span>
              <span className="pk-feature-body">{body}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="pk-foot">Pixel Kicks Tracking</p>
    </main>
  );
}

const CSS = `
  .pk {
    min-height: 100vh;
    margin: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 40px 20px;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1a1a1a;
    background: radial-gradient(1200px 600px at 50% -10%, #e9f5f0 0%, #f6f6f7 45%, #f6f6f7 100%);
  }
  .pk-card {
    width: 100%;
    max-width: 560px;
    background: #fff;
    border: 1px solid #e3e3e3;
    border-radius: 16px;
    padding: 40px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.04), 0 12px 32px rgba(0,0,0,0.06);
    box-sizing: border-box;
  }
  .pk-mark {
    width: 48px; height: 48px;
    border-radius: 12px;
    background: #0c5132;
    color: #fff;
    font-weight: 700;
    font-size: 18px;
    letter-spacing: 0.5px;
    display: flex; align-items: center; justify-content: center;
    margin-bottom: 20px;
  }
  .pk-title { font-size: 26px; font-weight: 680; margin: 0 0 8px; letter-spacing: -0.01em; }
  .pk-tag { font-size: 15px; line-height: 1.5; color: #4a4a4a; margin: 0 0 28px; }
  .pk-form { margin: 0 0 28px; }
  .pk-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; }
  .pk-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .pk-input {
    flex: 1 1 240px;
    min-width: 0;
    padding: 11px 13px;
    font-size: 14px;
    border: 1px solid #c9c9c9;
    border-radius: 9px;
    outline: none;
    transition: border-color .15s, box-shadow .15s;
  }
  .pk-input:focus { border-color: #0c5132; box-shadow: 0 0 0 3px rgba(12,81,50,0.15); }
  .pk-btn {
    padding: 11px 20px;
    font-size: 14px; font-weight: 600;
    color: #fff; background: #0c5132;
    border: 0; border-radius: 9px; cursor: pointer;
    transition: background .15s;
  }
  .pk-btn:hover { background: #0a4429; }
  .pk-hint { display: block; margin-top: 8px; font-size: 12px; color: #767676; }
  .pk-features { list-style: none; padding: 0; margin: 0; display: grid; gap: 14px; border-top: 1px solid #ededed; padding-top: 24px; }
  .pk-feature { display: flex; flex-direction: column; gap: 2px; }
  .pk-feature-title { font-size: 14px; font-weight: 600; }
  .pk-feature-body { font-size: 13px; line-height: 1.45; color: #5c5c5c; }
  .pk-foot { font-size: 12px; color: #9a9a9a; margin: 0; }
`;
