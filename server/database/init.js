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
        scan_count_mode BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Migration: add types column if upgrading from old schema with department
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS types TEXT[] NOT NULL DEFAULT '{}'`).catch(() => {});

    // Migration: add scan_count_mode for the Scan Count task type. Existing
    // (non-scan-count) tasks all default to FALSE, so their behavior is
    // completely unaffected — see server/routes/tasks.js for how this branches.
    await client.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS scan_count_mode BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});

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
        is_committed BOOLEAN DEFAULT FALSE,
        scan_count INTEGER NOT NULL DEFAULT 0,
        ever_scanned BOOLEAN NOT NULL DEFAULT FALSE
      )
    `);

    // Migration: add scan_count tally, used only by Scan Count mode tasks.
    // Unused (stays 0) for every existing/non-scan-count task item.
    await client.query(`ALTER TABLE task_items ADD COLUMN IF NOT EXISTS scan_count INTEGER NOT NULL DEFAULT 0`).catch(() => {});
    // Migration: ever_scanned distinguishes, in Scan Count mode, an item the
    // manager actually scanned at least once from one they never encountered
    // at all — both can end up with scan_count 0 and is_correct true when
    // Shopify's on-hand quantity for that SKU is also 0, but only the first
    // one was actually verified on the floor. See PATCH /scan-count (sets it
    // true), /restart-scan (resets it), and /complete-scan in tasks.js.
    await client.query(`ALTER TABLE task_items ADD COLUMN IF NOT EXISTS ever_scanned BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});

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

    // ─── PO Receiving (Purchasing) ───────────────────────────────────────────────

    await client.query(`
      CREATE TABLE IF NOT EXISTS po_suppliers (
        id                 SERIAL PRIMARY KEY,
        name               TEXT NOT NULL,
        currency           TEXT NOT NULL CHECK (currency IN ('USD','CAD')),
        fx_rate            NUMERIC(10,4),
        types_carrying     TEXT[] NOT NULL DEFAULT '{}',
        last_committed_at  TIMESTAMPTZ,
        created_at         TIMESTAMPTZ DEFAULT NOW(),
        updated_at         TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_po_suppliers_name_lower ON po_suppliers (LOWER(name))
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS po_supplier_skus (
        id            SERIAL PRIMARY KEY,
        supplier_id   INTEGER NOT NULL REFERENCES po_suppliers(id) ON DELETE CASCADE,
        code          TEXT NOT NULL,
        sku           TEXT NOT NULL,
        name          TEXT,
        product_type  TEXT,
        pack_size     INTEGER,
        last_cost     NUMERIC(12,4),
        cost_sum      NUMERIC(14,4) NOT NULL DEFAULT 0,
        cost_count    INTEGER NOT NULL DEFAULT 0,
        metafield_cost NUMERIC(12,4),
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (supplier_id, code, sku)
      )
    `);

    // Migration: "Supplier cost" metafield sync value (distinct from last_cost,
    // which is the cost actually applied at the most recent commit). Used as
    // the CSV cost-column fallback and as the "Cost" comparison column in the
    // invoice line item list — see server/routes/poInvoices.js.
    await client.query(`ALTER TABLE po_supplier_skus ADD COLUMN IF NOT EXISTS metafield_cost NUMERIC(12,4)`).catch(() => {});

    // Migration: a CSV line item given directly as SKU (no code) looks up its
    // fallback cost/name by (supplier_id, sku) — this is a plain index, NOT
    // unique: a supplier can legitimately have two different codes mapping to
    // the same sku (that's exactly what the existing SKU-collision detection
    // in poInvoices.js watches for), so a unique index here would break
    // Update SKU's rebuild the first time that happens.
    await client.query(`CREATE INDEX IF NOT EXISTS idx_po_supplier_skus_supplier_sku ON po_supplier_skus (supplier_id, sku)`).catch(() => {});

    // Migration: relax the old (supplier_id, code) uniqueness to
    // (supplier_id, code, sku). Some suppliers legitimately share one
    // "code" across several SKUs (one product, several variants, each with
    // its own SKU and its own cost) — the old constraint meant Update SKU's
    // wipe-and-rebuild could only keep ONE of those SKUs per code, silently
    // dropping the rest with no error (this is what surfaced as "some SKUs
    // never get updated even though their metafields are correct"). The new
    // composite key still allows the previously-supported reverse case (two
    // different codes pointing at the same SKU — the existing SKU-collision
    // detection in poInvoices.js) while also allowing one code to map to
    // several SKUs.
    // DROP CONSTRAINT IF EXISTS never errors even when the constraint or
    // table predates this migration, so it's safe with no extra guard.
    await client.query(`ALTER TABLE po_supplier_skus DROP CONSTRAINT IF EXISTS po_supplier_skus_supplier_id_code_key`).catch(() => {});
    // Guarded by name lookup (rather than a bare ALTER + .catch) so this is
    // idempotent across repeated deploys without risking the transaction-wide
    // poisoning a real duplicate-constraint error would otherwise cause.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'po_supplier_skus_code_sku_key'
        ) THEN
          ALTER TABLE po_supplier_skus ADD CONSTRAINT po_supplier_skus_code_sku_key UNIQUE (supplier_id, code, sku);
        END IF;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS po_invoices (
        id                  SERIAL PRIMARY KEY,
        invoice_number      TEXT NOT NULL,
        supplier_id         INTEGER NOT NULL REFERENCES po_suppliers(id),
        product_types       TEXT[] NOT NULL DEFAULT '{}',
        location            TEXT NOT NULL,
        shopify_location_id TEXT NOT NULL,
        adjustment_type     TEXT CHECK (adjustment_type IN ('amount','percentage')),
        adjustment_value    NUMERIC(12,4),
        is_promotional      BOOLEAN NOT NULL DEFAULT FALSE,
        status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','committed')),
        has_missing_sku     BOOLEAN NOT NULL DEFAULT FALSE,
        has_sku_collision   BOOLEAN NOT NULL DEFAULT FALSE,
        has_missing_cost    BOOLEAN NOT NULL DEFAULT FALSE,
        po_number           TEXT,
        committed_at        TIMESTAMPTZ,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_po_invoices_number_lower ON po_invoices (LOWER(invoice_number))
    `);

    // Migration: invoice_number becomes a free-text, non-unique reference —
    // the auto-assigned po_number below (format PO-A000, sequential via
    // po_number_counter) is now the canonical, unique identifier shown
    // everywhere in the app. See poInvoices.js's generatePoNumber().
    await client.query(`ALTER TABLE po_invoices ADD COLUMN IF NOT EXISTS po_number TEXT`).catch(() => {});
    await client.query(`DROP INDEX IF EXISTS idx_po_invoices_number_lower`).catch(() => {});
    await client.query(`ALTER TABLE po_invoices ALTER COLUMN invoice_number DROP NOT NULL`).catch(() => {});
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_po_invoices_po_number ON po_invoices (po_number)`).catch(() => {});
    // Migration: a line item whose cost is blank in the CSV AND has no
    // "Supplier cost" metafield fallback available is flagged the same way a
    // missing SKU is — blocks commit, rather than silently writing a 0 or
    // NULL cost into Shopify's moving-average cost calculation.
    await client.query(`ALTER TABLE po_invoices ADD COLUMN IF NOT EXISTS has_missing_cost BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS po_number_counter (
        id          INTEGER PRIMARY KEY DEFAULT 1,
        last_number INTEGER NOT NULL DEFAULT 0,
        last_letter TEXT NOT NULL DEFAULT 'A'
      )
    `);
    await client.query(`
      INSERT INTO po_number_counter (id, last_number, last_letter)
      VALUES (1, 0, 'A')
      ON CONFLICT (id) DO NOTHING
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS po_invoice_items (
        id                     SERIAL PRIMARY KEY,
        invoice_id             INTEGER NOT NULL REFERENCES po_invoices(id) ON DELETE CASCADE,
        code                   TEXT,
        sku                    TEXT,
        name                   TEXT,
        quantity               INTEGER NOT NULL,
        raw_cost               NUMERIC(12,4),
        unit_discount_raw      TEXT,
        cost_before_adjustment NUMERIC(12,4),
        effective_cost         NUMERIC(12,4),
        supplier_cost_raw      NUMERIC(12,4),
        is_missing             BOOLEAN NOT NULL DEFAULT FALSE,
        committed              BOOLEAN NOT NULL DEFAULT FALSE,
        created_at             TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Migration: code is now optional — a line item can be given directly by
    // SKU instead (see poInvoices.js POST /process). supplier_cost_raw
    // snapshots the "Supplier cost" comparison column (metafield_cost, in
    // the supplier's own invoice currency — NOT always CAD) at process time,
    // so the line item list doesn't need a live join to po_supplier_skus and
    // a later Update SKU run doesn't retroactively change what an
    // already-processed invoice displays.
    await client.query(`ALTER TABLE po_invoice_items ALTER COLUMN code DROP NOT NULL`).catch(() => {});
    // Renamed from supplier_cost_cad: that name was wrong — a USD supplier's
    // metafield cost is USD, not CAD. No production data exists yet, so this
    // is a plain rename with no backfill concerns. Guarded with an
    // information_schema check (rather than a bare ALTER + .catch) because
    // on a fresh database supplier_cost_cad never existed in the first place
    // (the CREATE TABLE above already uses supplier_cost_raw) — a plain
    // ALTER ... RENAME COLUMN there would error, and since this whole
    // function runs inside one BEGIN/COMMIT transaction, that error would
    // poison every migration statement after it for the rest of this run,
    // not just this one.
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'po_invoice_items' AND column_name = 'supplier_cost_cad'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'po_invoice_items' AND column_name = 'supplier_cost_raw'
        ) THEN
          ALTER TABLE po_invoice_items RENAME COLUMN supplier_cost_cad TO supplier_cost_raw;
        END IF;
      END $$;
    `);
    await client.query(`ALTER TABLE po_invoice_items ADD COLUMN IF NOT EXISTS supplier_cost_raw NUMERIC(12,4)`).catch(() => {});
    // A line item with no cost available at all (CSV blank + no metafield
    // fallback) stores NULL here rather than a fabricated 0 — the invoice's
    // has_missing_cost flag blocks it from being committed until fixed.
    await client.query(`ALTER TABLE po_invoice_items ALTER COLUMN raw_cost DROP NOT NULL`).catch(() => {});
    await client.query(`ALTER TABLE po_invoice_items ALTER COLUMN cost_before_adjustment DROP NOT NULL`).catch(() => {});
    await client.query(`ALTER TABLE po_invoice_items ALTER COLUMN effective_cost DROP NOT NULL`).catch(() => {});

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_po_invoice_items_invoice_id ON po_invoice_items (invoice_id)
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