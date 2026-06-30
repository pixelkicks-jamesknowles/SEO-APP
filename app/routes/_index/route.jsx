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

// PushON play ident (rounded triangle), Neon orange.
function Ident() {
  return (
    <svg className="pk-ident" viewBox="0 0 100 100" aria-hidden="true">
      <path d="M34 24 L76 50 L34 76 Z" fill="none" stroke="#FF530D" strokeWidth="11" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export default function App() {
  const { showForm } = useLoaderData();
  return (
    <main className="pk">
      <style>{CSS}</style>
      <svg className="pk-wave pk-wave-tr" viewBox="0 0 480 320" aria-hidden="true">
        <path d="M40 220 C120 80 220 80 280 180 S420 280 520 140" fill="none" stroke="#FF530D" strokeWidth="60" strokeLinecap="round" />
      </svg>
      <svg className="pk-wave pk-wave-bl" viewBox="0 0 480 320" aria-hidden="true">
        <path d="M-40 180 C60 300 180 300 240 180 S380 60 500 140" fill="none" stroke="#FF530D" strokeWidth="60" strokeLinecap="round" />
      </svg>

      <div className="pk-card">
        <div className="pk-brand">
          <Ident />
          <span className="pk-wordmark">PushON</span>
        </div>

        <h1 className="pk-title">Pixel Kicks <span className="pk-accent">Tracking</span></h1>
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

      <p className="pk-foot">eCommerce. Delivered.</p>
    </main>
  );
}

// PushON brand: Night #050C44, Neon #FF530D, Regent #F4F8FE, white.
const CSS = `
  .pk {
    position: relative;
    min-height: 100vh;
    margin: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 20px;
    padding: 48px 20px;
    box-sizing: border-box;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #fff;
    background: #050C44;
  }
  .pk-wave { position: absolute; width: 520px; max-width: 60vw; opacity: 0.9; z-index: 0; pointer-events: none; }
  .pk-wave-tr { top: -40px; right: -60px; }
  .pk-wave-bl { bottom: -50px; left: -70px; transform: rotate(8deg); }

  .pk-card {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 560px;
    background: #fff;
    border-radius: 20px;
    padding: 44px;
    box-shadow: 0 20px 60px rgba(5,12,68,0.45);
    box-sizing: border-box;
    color: #050C44;
  }
  .pk-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; }
  .pk-ident { width: 34px; height: 34px; }
  .pk-wordmark { font-size: 22px; font-weight: 800; color: #FF530D; letter-spacing: -0.01em; }

  .pk-title { font-size: 30px; font-weight: 800; margin: 0 0 10px; letter-spacing: -0.02em; line-height: 1.1; color: #050C44; }
  .pk-accent { color: #FF530D; }
  .pk-tag { font-size: 15px; line-height: 1.55; color: #3a4163; margin: 0 0 30px; }

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
  .pk-input:focus { border-color: #FF530D; box-shadow: 0 0 0 3px rgba(255,83,13,0.18); }
  .pk-btn {
    padding: 12px 22px; font-size: 14px; font-weight: 700;
    color: #fff; background: #FF530D; border: 0; border-radius: 10px; cursor: pointer;
    transition: background .15s, transform .05s;
  }
  .pk-btn:hover { background: #e7440a; }
  .pk-btn:active { transform: translateY(1px); }
  .pk-hint { display: block; margin-top: 8px; font-size: 12px; color: #767ca0; }

  .pk-features { list-style: none; padding: 0; margin: 0; display: grid; gap: 16px; border-top: 1px solid #ECEEF4; padding-top: 26px; }
  .pk-feature { display: flex; flex-direction: column; gap: 3px; }
  .pk-feature-title { font-size: 14px; font-weight: 700; color: #050C44; }
  .pk-feature-body { font-size: 13px; line-height: 1.5; color: #5a6182; }

  .pk-foot { position: relative; z-index: 1; font-size: 12px; font-weight: 600; color: #F4F8FE; opacity: 0.7; margin: 0; }

  @media (max-width: 600px) { .pk-card { padding: 32px 24px; } .pk-wave { display: none; } }
`;
