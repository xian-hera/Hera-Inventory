const { shopifyApi, ApiVersion, Session } = require('@shopify/shopify-api');
const { nodeAdapterPackage } = require('@shopify/shopify-api/adapters/node');

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

  // --- Auth routes ---

  // Step 1: Begin OAuth
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

  // Step 2: OAuth callback
  app.get('/auth/callback', async (req, res) => {
    try {
      const callbackResponse = await shopify.auth.callback({
        rawRequest: req,
        rawResponse: res,
      });

      const session = callbackResponse.session;
      console.log(`✓ Auth complete for shop: ${session.shop}`);
      console.log(`  Access token: ${session.accessToken}`);

      // Save session to .env hint (in production, save to DB)
      // For now, store in memory
      currentSession = session;

      // Redirect to app
      const host = req.query.host;
      res.redirect(`/?shop=${session.shop}&host=${host}`);
    } catch (e) {
      console.error('Auth callback error:', e);
      res.status(500).send(e.message);
    }
  });

  // Middleware to verify Shopify session for API routes
  app.use('/api', async (req, res, next) => {
    // Skip health check
    if (req.path === '/health') return next();

    try {
      const sessionId = await shopify.session.getCurrentId({
        isOnline: false,
        rawRequest: req,
        rawResponse: res,
      });

      if (!sessionId && !currentSession) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      req.shopifySession = currentSession;
      next();
    } catch (e) {
      console.error('Session verification error:', e);
      next(); // Allow through during development
    }
  });
};

// In-memory session store (will move to DB later)
let currentSession = null;

const getSession = () => currentSession;

const getShopify = () => shopify;

module.exports = { setupShopify, getSession, getShopify };