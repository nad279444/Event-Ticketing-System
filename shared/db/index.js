import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const config = { connectionString };
// Managed Postgres (Neon, Cloud SQL via proxyless SSL) requires SSL;
// local dev Postgres in docker-compose does not use SSL.
if (
  connectionString.includes('sslmode=require') ||
  connectionString.includes('.neon.tech')
) {
  config.ssl = { rejectUnauthorized: false };
}

export const pool = new Pool(config);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS orders (
    id          SERIAL PRIMARY KEY,
    event_type  TEXT NOT NULL,
    customer    TEXT NOT NULL,
    quantity    INT  NOT NULL DEFAULT 1,
    unit_price  NUMERIC(10, 2) NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    fulfilled_at TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders (lower(customer));
  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);
`;

export async function initSchema({ retries = 10, delayMs = 3000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query(SCHEMA);
      console.log('✓ Database schema ready');
      return;
    } catch (error) {
      if (attempt === retries) {
        throw new Error(
          `Database schema init failed after ${retries} attempts: ${error.message}`,
        );
      }
      console.log(
        `Database not ready (attempt ${attempt}/${retries}), retrying in ${delayMs / 1000}s...`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
