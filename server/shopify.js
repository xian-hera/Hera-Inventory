const { shopifyApi, ApiVersion, Session } = require('@shopify/shopify-api');
const { nodeAdapterPackage } = require('@shopify/shopify-api/adapters/node');
const { pool } = require('./database/init');

let shopify;

const setupShopify = (app) => {
  shopify = shopifyApi({
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecretKey: process.env.SHOPIFY_API_SECRET,
    scopes: process.env.SHOPIFY_SCOPES.split(','),
    hostName: process.env.HOST.replace(/https?:\/\//, ''),
    apiVersion: ApiVersion.January25,
    isEmbeddedApp: true,
    ...nodeAdapterPackage,
  });

  // Begin OAuth
  app.get('/auth', async (req, res) => {
    const shop = req.query.shop || process.env.SHOP;
    if (!shop) return res.status(400).send('Missing shop parameter');

    await shopify.auth.begin({
      shop: shopify.utils.sanitizeShop(shop, true),
      callbackPath: '/auth/callback',
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
  });

  // OAuth callback
  app.get('/auth/callback', async (req, res) => {
    try {
      const callbackResponse = await shopify.auth.callback({
        rawRequest: req,
        rawResponse: res,
      });

      const session = callbackResponse.session;
      console.log(`✓ Auth complete for shop: ${session.shop}`);

      // Save session to DB
      await saveSession(session);

      const host = req.query.host;
      res.redirect(`/?shop=${session.shop}&host=${host}`);
    } catch (e) {
      console.error('Auth callback error:', e);
      res.status(500).send(e.message);
    }
  });

  // Middleware for API routes
  app.use('/api', async (req, res, next) => {
    if (req.path === '/health') return next();
    try {
      const session = await loadSession(process.env.SHOP);
      if (!session) return res.status(401).json({ error: 'Unauthorized' });
      req.shopifySession = session;
      next();
    } catch (e) {
      console.error('Session load error:', e);
      next();
    }
  });
};

// Save session to DB
const saveSession = async (session) => {
  await pool.query(
    `INSERT INTO sessions (id, shop, state, is_online, scope, expires, access_token, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (id) DO UPDATE SET
       access_token = $7,
       scope = $5,
       expires = $6,
       updated_at = NOW()`,
    [
      session.id,
      session.shop,
      session.state || null,
      session.isOnline || false,
      session.scope || null,
      session.expires || null,
      session.accessToken,
    ]
  );
};

// Load session from DB by shop
const loadSession = async (shop) => {
  const result = await pool.query(
    'SELECT * FROM sessions WHERE shop = $1 ORDER BY updated_at DESC LIMIT 1',
    [shop]
  );
  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const session = new Session({
    id: row.id,
    shop: row.shop,
    state: row.state || '',
    isOnline: row.is_online,
    scope: row.scope || '',
    accessToken: row.access_token,
    expires: row.expires ? new Date(row.expires) : undefined,
  });
  return session;
};

const getSession = async () => {
  return await loadSession(process.env.SHOP);
};

const getShopify = () => shopify;

module.exports = { setupShopify, getSession, getShopify };