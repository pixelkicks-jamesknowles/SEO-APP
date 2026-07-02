import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { login } from "../../shopify.server";

// TODO: confirm / replace these before launch.
const SUPPORT_EMAIL = "support@pushon.co.uk";
const PRIVACY_URL = "https://www.pushon.co.uk/privacy-policy/"; // host privacy-policy.md here

export const meta = () => [
  { title: "Pixel Kicks Tracking by PushON" },
  { name: "description", content: "Accurate server-side conversion tracking for Shopify. GA4, Meta and GTM, with no theme code." },
  { property: "og:title", content: "Pixel Kicks Tracking" },
  { property: "og:description", content: "Server-side GA4, Meta and GTM tracking for Shopify that survives ad blockers, ITP and checkout." },
  { property: "og:type", content: "website" },
];

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

// Normalise whatever the merchant types into a clean myshopify.com domain before submit.
function normaliseShop(e) {
  const input = e.currentTarget.elements.shop;
  if (!input) return;
  let v = (input.value || "").trim().toLowerCase();
  v = v.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (v && !v.includes(".")) v = `${v}.myshopify.com`;
  input.value = v;
}

export default function App() {
  const { showForm } = useLoaderData();
  return (
    <main className="pk">
      <style>{CSS}</style>
      <div className="pk-card">
        <h1 className="pk-title">Pixel Kicks <span className="pk-accent">Tracking</span></h1>
        <p className="pk-tag">
          Accurate server-side conversion tracking for Shopify. GA4, Meta and GTM, with no theme code.
        </p>
        <p className="pk-sub">
          Runs alongside your existing GA4 setup and the Google &amp; YouTube app, with no double-counting.
        </p>

        {showForm && (
          <Form className="pk-form" method="post" action="/auth/login" onSubmit={normaliseShop}>
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

        <footer className="pk-footer">
          <a className="pk-link" href={PRIVACY_URL} target="_blank" rel="noreferrer">Privacy policy</a>
          <span className="pk-dot">·</span>
          <a className="pk-link" href={`mailto:${SUPPORT_EMAIL}`}>Support</a>
          <span className="pk-dot">·</span>
          <span className="pk-credit">Built by PushON</span>
        </footer>
      </div>
    </main>
  );
}

// PushON accents (Night #050C44, Neon #005aff) on a clean light background.
const CSS = `
  .pk {
    min-height: 100vh;
    margin: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 48px 20px;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #050C44;
    background: #fff;
  }
  .pk-card {
    width: 100%;
    max-width: 560px;
    background: #fff;
    border: 1px solid #e6e8f0;
    border-radius: 18px;
    padding: 44px;
    box-shadow: 0 1px 2px rgba(5,12,68,0.04), 0 10px 30px rgba(5,12,68,0.07);
    box-sizing: border-box;
  }
  .pk-title { font-size: 30px; font-weight: 800; margin: 0 0 10px; letter-spacing: -0.02em; line-height: 1.1; color: #050C44; }
  .pk-accent { color: #005aff; }
  .pk-tag { font-size: 15px; line-height: 1.55; color: #3a4163; margin: 0 0 8px; }
  .pk-sub { font-size: 13px; line-height: 1.5; color: #767ca0; margin: 0 0 30px; }

  .pk-form { margin: 0 0 30px; }
  .pk-label { display: block; font-size: 13px; font-weight: 700; margin-bottom: 8px; color: #050C44; }
  .pk-row { display: flex; gap: 8px; flex-wrap: wrap; }
  .pk-input {
    flex: 1 1 240px; min-width: 0;
    padding: 12px 14px; font-size: 14px;
    border: 1.5px solid #d4d8e6; border-radius: 10px;
    color: #050C44; outline: none;
    transition: border-color .15s, box-shadow .15s;
  }
  .pk-input::placeholder { color: #9aa0bb; }
  .pk-input:focus { border-color: #005aff; box-shadow: 0 0 0 3px rgba(0,90,255,0.18); }
  .pk-btn {
    padding: 12px 22px; font-size: 14px; font-weight: 700;
    color: #fff; background: #005aff; border: 0; border-radius: 10px; cursor: pointer;
    transition: background .15s, transform .05s;
  }
  .pk-btn:hover { background: #0048cc; }
  .pk-btn:active { transform: translateY(1px); }
  .pk-hint { display: block; margin-top: 8px; font-size: 12px; color: #767ca0; }

  .pk-features { list-style: none; padding: 0; margin: 0; display: grid; gap: 16px; border-top: 1px solid #ECEEF4; padding-top: 26px; }
  .pk-feature { display: flex; flex-direction: column; gap: 3px; }
  .pk-feature-title { font-size: 14px; font-weight: 700; color: #050C44; }
  .pk-feature-body { font-size: 13px; line-height: 1.5; color: #5a6182; }

  .pk-footer { margin-top: 28px; padding-top: 20px; border-top: 1px solid #ECEEF4; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: #767ca0; }
  .pk-link { color: #050C44; text-decoration: none; font-weight: 600; }
  .pk-link:hover { color: #005aff; text-decoration: underline; }
  .pk-dot { color: #c3c7da; }
  .pk-credit { color: #767ca0; }

  @media (max-width: 600px) { .pk-card { padding: 32px 24px; } }
`;
