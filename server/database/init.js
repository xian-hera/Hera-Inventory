const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const initDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS location_map (
        location_name TEXT PRIMARY KEY,
        shopify_location_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        task_no TEXT UNIQUE NOT NULL,
        types TEXT[] NOT NULL DEFAULT '{}',
        location TEXT NOT NULL,
        shopify_location_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        filter_summary TEXT,
        notes JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Migration: add types column if upgrading from old schema with department
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS types TEXT[] NOT NULL DEFAULT '{}'`).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS task_items (
        id SERIAL PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        barcode TEXT NOT NULL,
        name TEXT,
        soh INTEGER,
        scan_history JSONB DEFAULT '[]',
        poh INTEGER,
        is_correct BOOLEAN DEFAULT FALSE,
        is_committed BOOLEAN DEFAULT FALSE
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS zero_qty_reports (
        id SERIAL PRIMARY KEY,
        barcode TEXT NOT NULL,
        name TEXT,
        type TEXT,
        location TEXT NOT NULL,
        shopify_location_id TEXT NOT NULL,
        soh INTEGER,
        poh INTEGER,
        status TEXT NOT NULL DEFAULT 'reviewing',
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        committed_at TIMESTAMPTZ
      )
    `);

    // Migration: add type column if upgrading from old schema with department
    await client.query(`ALTER TABLE zero_qty_reports ADD COLUMN IF NOT EXISTS type TEXT`).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        shop TEXT NOT NULL,
        state TEXT,
        is_online BOOLEAN DEFAULT FALSE,
        scope TEXT,
        expires TIMESTAMPTZ,
        access_token TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── Stock Losses ───────────────────────────────────────────────────────────

    // Local supplier brand list (vendor names)
    await client.query(`
      CREATE TABLE IF NOT EXISTS local_supplier_brands (
        id SERIAL PRIMARY KEY,
        vendor TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Stock Losses settings matrix (type × reason → photo/instruction config)
    // type_value: 'ALL' | any product type string | custom type label
    // reason: 'damaged_delivery' | 'damaged_employee' | 'expired' | 'stolen' | 'tester' | 'other' | custom
    // metafield_namespace, metafield_key, metafield_value: optional sub-condition for custom type rows
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_losses_settings (
        id SERIAL PRIMARY KEY,
        type_value TEXT NOT NULL,
        type_label TEXT NOT NULL,
        metafield_level TEXT,
        metafield_namespace TEXT,
        metafield_key TEXT,
        metafield_value TEXT,
        reason TEXT NOT NULL,
        reason_label TEXT NOT NULL,
        photo_required BOOLEAN NOT NULL DEFAULT FALSE,
        instruction_text TEXT,
        local_supplier_instruction_text TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (type_value, reason)
      )
    `);

    // Custom reasons added by buyer (beyond the 5 built-in ones)
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_losses_custom_reasons (
        id SERIAL PRIMARY KEY,
        reason_key TEXT NOT NULL UNIQUE,
        reason_label TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Stock Losses entries submitted by managers
    await client.query(`
      CREATE TABLE IF NOT EXISTS stock_losses (
        id SERIAL PRIMARY KEY,
        barcode TEXT NOT NULL,
        name TEXT,
        product_type TEXT,
        vendor TEXT,
        location TEXT NOT NULL,
        shopify_location_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        reason_label TEXT NOT NULL,
        reason_detail TEXT,
        qty INTEGER NOT NULL,
        adjustment INTEGER NOT NULL,
        soh INTEGER,
        photo_urls TEXT[] DEFAULT '{}',
        shopify_file_gids TEXT[] DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'reviewing',
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        committed_at TIMESTAMPTZ,
        archived_at TIMESTAMPTZ
      )
    `);

    // ────────────────────────────────────────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS task_counter (
        id INTEGER PRIMARY KEY DEFAULT 1,
        last_number INTEGER NOT NULL DEFAULT 0,
        last_letter TEXT NOT NULL DEFAULT 'A'
      )
    `);

    await client.query(`
      INSERT INTO task_counter (id, last_number, last_letter)
      VALUES (1, 0, 'A')
      ON CONFLICT (id) DO NOTHING
    `);

    // ─── CRM / Hairdresser ──────────────────────────────────────────────────────

    // Hairdressers enrolled in the referral programme
    await client.query(`
      CREATE TABLE IF NOT EXISTS hairdressers (
        id SERIAL PRIMARY KEY,
        shopify_customer_id VARCHAR NOT NULL UNIQUE,
        name VARCHAR NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Referral link history — one active link per hairdresser at a time
    // is_active: only the most recently generated link is TRUE
    await client.query(`
      CREATE TABLE IF NOT EXISTS referral_links (
        id SERIAL PRIMARY KEY,
        hairdresser_id INTEGER NOT NULL REFERENCES hairdressers(id) ON DELETE CASCADE,
        url VARCHAR NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        generated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Customer–hairdresser binding records (each bind / renew = new row, history preserved)
    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_bindings (
        id SERIAL PRIMARY KEY,
        customer_shopify_id VARCHAR NOT NULL,
        hairdresser_id INTEGER NOT NULL REFERENCES hairdressers(id) ON DELETE CASCADE,
        bound_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Statistics cache — one row per hairdresser, replaced on each recalculation
    await client.query(`
      CREATE TABLE IF NOT EXISTS statistics_cache (
        id SERIAL PRIMARY KEY,
        hairdresser_id INTEGER NOT NULL UNIQUE REFERENCES hairdressers(id) ON DELETE CASCADE,
        date_from DATE NOT NULL,
        date_to DATE NOT NULL,
        total_customers INTEGER NOT NULL DEFAULT 0,
        total_revenue DECIMAL(10,2) NOT NULL DEFAULT 0,
        calculated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ────────────────────────────────────────────────────────────────────────────

    await client.query('COMMIT');
    console.log('✓ Database initialized successfully');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Database initialization error:', e);
    throw e;
  } finally {
    client.release();
  }
};

module.exports = { pool, initDatabase };