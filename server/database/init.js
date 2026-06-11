const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const initDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Enable pg_trgm for trigram-based fuzzy search on variant_search_index
    await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);

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

    await client.query(`
      CREATE TABLE IF NOT EXISTS hairdressers (
        id SERIAL PRIMARY KEY,
        shopify_customer_id VARCHAR NOT NULL UNIQUE,
        name VARCHAR NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS referral_links (
        id SERIAL PRIMARY KEY,
        hairdresser_id INTEGER NOT NULL REFERENCES hairdressers(id) ON DELETE CASCADE,
        url VARCHAR NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        generated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_bindings (
        id SERIAL PRIMARY KEY,
        customer_shopify_id VARCHAR NOT NULL,
        hairdresser_id INTEGER NOT NULL REFERENCES hairdressers(id) ON DELETE CASCADE,
        bound_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

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

    await client.query(`
      CREATE TABLE IF NOT EXISTS hairdresser_notes (
        id SERIAL PRIMARY KEY,
        hairdresser_id INTEGER NOT NULL REFERENCES hairdressers(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS hairdresser_activity_log (
        id SERIAL PRIMARY KEY,
        hairdresser_id INTEGER NOT NULL REFERENCES hairdressers(id) ON DELETE CASCADE,
        action VARCHAR NOT NULL,
        detail TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ────────────────────────────────────────────────────────────────────────────

    // ─── App Settings (global key-value store) ──────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ─── Employee Cap ────────────────────────────────────────────────────────────

    // employees: synced from Connecteam
    // branches: TEXT[] — one employee can belong to multiple branches
    // status: 'active' | 'archived'
    await client.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id                   SERIAL PRIMARY KEY,
        connecteam_user_id   VARCHAR(100) NOT NULL UNIQUE,
        name                 TEXT NOT NULL,
        email                TEXT,
        branches             TEXT[] NOT NULL DEFAULT '{}',
        status               TEXT NOT NULL DEFAULT 'active',
        shopify_customer_id  VARCHAR(100),
        created_at           TIMESTAMPTZ DEFAULT NOW(),
        updated_at           TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_employees_status ON employees (status)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_employees_email ON employees (email)
    `);

    // employee_purchases: persisted total purchase per employee per season
    // season format: '2025-S1' | '2025-S2' | '2025-S3' | '2025-S4'
    await client.query(`
      CREATE TABLE IF NOT EXISTS employee_purchases (
        id                SERIAL PRIMARY KEY,
        employee_id       INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        season            TEXT NOT NULL,
        total_amount      DECIMAL(10,2) NOT NULL DEFAULT 0,
        last_refreshed_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (employee_id, season)
      )
    `);

    // employee_settings: global settings + per-location last refresh timestamps
    // key examples:
    //   'cap_amount'          → { value: 600 }
    //   'cap_tax_mode'        → { value: 'before_tax' | 'after_tax' }
    //   'last_refresh_all'    → { refreshed_at: ISO string }
    //   'last_refresh_MTL01'  → { refreshed_at: ISO string }
    await client.query(`
      CREATE TABLE IF NOT EXISTS employee_settings (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Seed defaults if not already present
    await client.query(`
      INSERT INTO employee_settings (key, value)
      VALUES
        ('cap_amount',   '{"value": 600}'),
        ('cap_tax_mode', '{"value": "before_tax"}')
      ON CONFLICT (key) DO NOTHING
    `);

    // ────────────────────────────────────────────────────────────────────────────

    // ─── Variant Search Index ───────────────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS variant_search_index (
        id                  SERIAL PRIMARY KEY,
        shopify_variant_id  VARCHAR(100) NOT NULL UNIQUE,
        shopify_product_id  VARCHAR(100) NOT NULL,
        sku                 VARCHAR(255),
        barcode             VARCHAR(255),
        custom_name         TEXT,
        product_title       TEXT,
        product_type        VARCHAR(255),
        vendor              VARCHAR(255),
        synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_variant_search_custom_name_trgm
      ON variant_search_index
      USING GIN (custom_name gin_trgm_ops)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_variant_search_product_title_trgm
      ON variant_search_index
      USING GIN (product_title gin_trgm_ops)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_variant_search_sku
      ON variant_search_index (sku)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_variant_search_barcode
      ON variant_search_index (barcode)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_variant_search_product_id
      ON variant_search_index (shopify_product_id)
    `);

    // ─── Birthday Campaign ───────────────────────────────────────────────────────
    // 顾客点击生日邮件按钮 → Netlify 通知本 APP → 加 birthday_campaign tag +
    // 写 birthday_campaign_log；Remove Job 到期时拉取该顾客 tag 期间订单存入
    // birthday_orders，并摘 tag。

    // 配置表（单行，id=1）。仅保留 Remove Job 相关配置。
    await client.query(`
      CREATE TABLE IF NOT EXISTS birthday_config (
        id                 INTEGER PRIMARY KEY DEFAULT 1,
        enabled            BOOLEAN NOT NULL DEFAULT TRUE,
        remove_job_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        remove_job_hour    INTEGER NOT NULL DEFAULT 23,
        remove_job_minute  INTEGER NOT NULL DEFAULT 30,
        tag_delay_hours    INTEGER NOT NULL DEFAULT 48,
        campaign_tag       TEXT NOT NULL DEFAULT 'birthday_campaign',
        updated_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // 种子配置行
    await client.query(`
      INSERT INTO birthday_config (id) VALUES (1)
      ON CONFLICT (id) DO NOTHING
    `);

    // tag 记录表（核心）。status: 'pending' | 'removed' | 'failed'
    // 注意：id 用 SERIAL（与现有库一致），不是 BIGSERIAL。
    await client.query(`
      CREATE TABLE IF NOT EXISTS birthday_campaign_log (
        id             SERIAL PRIMARY KEY,
        customer_id    TEXT NOT NULL,
        email          TEXT,
        tag_added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        tag_remove_at  TIMESTAMPTZ NOT NULL,
        tag_removed_at TIMESTAMPTZ,
        status         TEXT NOT NULL DEFAULT 'pending'
      )
    `);

    // 现有库已有索引 idx_birthday_log_pending（部分索引，针对 pending 状态），
    // 这里不重复创建。如果是全新库，部署时建议手动评估是否要加 (status, tag_remove_at) 复合索引。

    // 订单记录表。order_id 唯一约束 → 配合 ON CONFLICT 做幂等。
    // id 用 SERIAL、log_id 用 INTEGER，与 birthday_campaign_log.id 类型对齐。
    await client.query(`
      CREATE TABLE IF NOT EXISTS birthday_orders (
        id               SERIAL PRIMARY KEY,
        log_id           INTEGER NOT NULL REFERENCES birthday_campaign_log(id) ON DELETE CASCADE,
        customer_id      TEXT NOT NULL,
        order_id         TEXT NOT NULL UNIQUE,
        order_name       TEXT,
        order_amount     NUMERIC(12,2) NOT NULL DEFAULT 0,
        currency         TEXT DEFAULT 'CAD',
        order_created_at TIMESTAMPTZ,
        recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_birthday_orders_log
      ON birthday_orders (log_id)
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