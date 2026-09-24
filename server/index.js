require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { setupShopify } = require('./shopify');
const { initDatabase } = require('./database/init');
const birthdayRoute = require('./routes/birthday');
const { router: birthdayConfigRouter, registerRestartFn } = require('./routes/birthdayConfig');
const { startBirthdayScheduler } = require('./jobs/birthdayScheduler');
const { startSyncScheduler } = require('./jobs/syncVariantIndex');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());

// Birthday webhook must be registered before express.json()
// because it needs raw body for HMAC verification
app.use('/api/birthday', birthdayRoute);

// Connecteam webhook — registered before express.json() so raw body is available if needed
// (currently uses JSON body, but keeping it early in case HMAC verification is added later)
app.use('/api/employees/webhook/connecteam', require('./routes/employees'));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Setup Shopify auth routes
setupShopify(app);

app.use('/api/reports', require('./routes/reports'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/stock-losses', require('./routes/stockLosses'));
app.use('/api/stock-losses-settings', require('./routes/stockLossesSettings'));
app.use('/api/badges', require('./routes/badges'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/shopify', require('./routes/shopify').router);
app.use('/api/label-templates', require('./routes/labelTemplates'));
app.use('/api/label-print-tasks', require('./routes/labelPrintTasks'));
app.use('/api/price-change-tasks', require('./routes/priceChangeTasks'));
app.use('/api/hairdressers', require('./routes/hairdressers'));
app.use('/api/birthday-config', birthdayConfigRouter);
app.use('/api/influencers', require('./routes/influencers'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/employees', require('./routes/employees'));
app.use('/api/po-suppliers', require('./routes/poSuppliers'));
app.use('/api/po-invoices', require('./routes/poInvoices'));
app.use('/api/po-settings', require('./routes/poSettings'));
app.use('/api/transfers', require('./routes/transfers'));
app.use('/api/box-po', require('./routes/boxPo'));
app.use('/api/manager-history', require('./routes/managerHistory').router);
app.use('/api/wig-demo', require('./routes/wigDemo'));

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/build')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/build', 'index.html'));
  });
}

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!', message: err.message });
});

// Start server
const startServer = async () => {
  try {
    await initDatabase();
    await startBirthdayScheduler();
    registerRestartFn(startBirthdayScheduler);
    await startSyncScheduler();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
    // Shared location map (2026-09-24): refresh location_map from Shopify once
    // per boot so a deploy never serves a stale list. Fire-and-forget — a
    // failure here only logs; the existing rows stay as they were and the
    // Buyer Settings "Sync Locations" button can retry.
    require('./routes/shopify').syncLocationMap()
      .then(r => console.log(`[location-map] synced at startup: ${r.active.length} active`))
      .catch(e => console.error('[location-map] startup sync failed:', e.message));
  } catch (e) {
    console.error('Failed to start server:', e);
    process.exit(1);
  }
};

startServer();