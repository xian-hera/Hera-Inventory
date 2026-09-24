// GraphQL helper for Import Products (buyer) and New Products (online),
// added 2026-09-24. Uses the same shopify-api Graphql client as the rest of
// the app, but throws on GraphQL errors and retries on throttling.
const { getShopify, getSession } = require('../shopify');

async function getClient() {
  const session = await getSession();
  if (!session) throw new Error('No Shopify session');
  const shopify = getShopify();
  return new shopify.clients.Graphql({ session });
}

function errorText(errors) {
  if (!errors) return '';
  if (Array.isArray(errors)) return errors.map(x => (x && x.message) || String(x)).join('; ');
  if (errors.graphQLErrors) return errorText(errors.graphQLErrors);
  if (errors.message) return errors.message;
  return String(errors);
}

function looksThrottled(text) {
  return /throttl/i.test(text || '');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function gql(query, variables = {}, retries = 6) {
  const client = await getClient();
  for (let attempt = 0; ; attempt++) {
    let text = '';
    try {
      const response = await client.request(query, { variables });
      text = errorText(response && response.errors);
      if (!text) return response.data;
    } catch (e) {
      text = errorText(e && e.response && e.response.errors) || (e && e.message) || 'Shopify request failed';
      if (e && e.response && e.response.status === 429) text = 'Throttled';
    }
    if (looksThrottled(text) && attempt < retries) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    throw new Error(text);
  }
}

// Turn a mutation payload's userErrors into one readable string ('' if none).
function userErrorText(payload) {
  const list = (payload && payload.userErrors) || [];
  return list
    .map(u => {
      const field = Array.isArray(u.field) ? u.field.join('.') : '';
      return field ? `${field}: ${u.message}` : u.message;
    })
    .join('; ');
}

// Numeric id from a gid, for admin.shopify.com links.
function numericId(gid) {
  const m = String(gid || '').match(/(\d+)$/);
  return m ? m[1] : '';
}

// Quote a value for Shopify search syntax.
function searchQuote(v) {
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

module.exports = { gql, userErrorText, numericId, searchQuote, sleep };
