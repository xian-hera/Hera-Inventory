const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const initDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Location map table
    await client.query(`
      CREATE TABLE IF NOT EXISTS location_map (
        location_name TEXT PRIMARY KEY,
        shopify_location_id TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Tasks table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        task_no TEXT UNIQUE NOT NULL,
        department TEXT NOT NULL,
        location TEXT NOT NULL,
        shopify_location_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        filter_summary TEXT,
        notes JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Task items table
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

    // Zero quantity reports table
    await client.query(`
      CREATE TABLE IF NOT EXISTS zero_qty_reports (
        id SERIAL PRIMARY KEY,
        barcode TEXT NOT NULL,
        name TEXT,
        department TEXT,
        location TEXT NOT NULL,
        shopify_location_id TEXT NOT NULL,
        soh INTEGER,
        poh INTEGER,
        status TEXT NOT NULL DEFAULT 'reviewing',
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        committed_at TIMESTAMPTZ
      )
    `);

    // Task number counter table
    await client.query(`
      CREATE TABLE IF NOT EXISTS task_counter (
        id INTEGER PRIMARY KEY DEFAULT 1,
        last_number INTEGER NOT NULL DEFAULT 0,
        last_letter TEXT NOT NULL DEFAULT 'A'
      )
    `);

    // Insert initial counter if not exists
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