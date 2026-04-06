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
      CREATE TABLE IF NOT EXISTS task_counter (
        id INTEGER PRIMARY KEY DEFAULT 1,
        last_number INTEGER NOT NULL DEFAULT 0,
        last_letter TEXT NOT NULL DEFAULT 'A'
      )
    `);

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

    await client.query(`
      INSERT INTO task_counter (id, last_number, last_letter)
      VALUES (1, 0, 'A')
      ON CONFLICT (id) DO NOTHING
    `);

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