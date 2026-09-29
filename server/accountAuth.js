// Account identification (2026-09-29, Hera).
//
// Works out WHICH Shopify staff account is using the Hub, so the PIN
// "remembered for 30 days" state and the Store (manager) location can be
// remembered per account on the server instead of in the browser's
// localStorage. Background: the Hub runs as a cross-site iframe inside
// Shopify Admin, and on iOS (Shopify app / WebKit) that iframe's
// localStorage is wiped whenever the WebView is recreated — so the old
// per-device memory kept forgetting. Every store has its own Shopify
// account (confirmed by Hera), so "per account" is safe for location too.
//
// How: the frontend asks Shopify App Bridge for a session token
// (shopify.idToken()) and sends it as `Authorization: Bearer <token>`.
// Shopify signs that token with our app secret, so the backend can trust
// its `sub` claim (the staff user's numeric Shopify user ID). The frontend
// is NEVER trusted to just say "I am account X".
//
// Returns the user ID as a string, or null when there is no token / it is
// invalid / expired. A null result is not an error: every caller falls back
// to the old localStorage behaviour, so a page never gets locked out because
// of this. Callers must NOT answer with a 401 { reauth } for a missing
// account — client/src/index.js turns that into a full-page OAuth redirect.

const { getShopify } = require('./shopify');

async function getAccountId(req) {
  try {
    const header = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return null;
    const shopify = getShopify();
    if (!shopify) return null;
    const payload = await shopify.session.decodeSessionToken(match[1]);
    if (!payload || payload.sub === undefined || payload.sub === null || payload.sub === '') return null;
    return String(payload.sub);
  } catch (e) {
    // Don't log e.message: shopify-api puts the whole token in it.
    console.warn('[account] session token rejected:', e && e.name);
    return null;
  }
}

module.exports = { getAccountId };
