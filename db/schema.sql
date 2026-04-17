-- NoFrontDesk SaaS Database Schema
-- Run with: npm run migrate

-- ─────────────────────────────────────────────
-- Session store (for express-session)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "session" (
  "sid" VARCHAR NOT NULL COLLATE "default",
  "sess" JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL,
  PRIMARY KEY ("sid")
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- ─────────────────────────────────────────────
-- Customer accounts
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  company_name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  plan VARCHAR(50) DEFAULT 'trial',
  plan_unit_limit INT DEFAULT 5,
  trial_ends_at TIMESTAMP DEFAULT (NOW() + INTERVAL '14 days'),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- Guesty API credentials (per account)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_credentials (
  id SERIAL PRIMARY KEY,
  account_id INT REFERENCES accounts(id) ON DELETE CASCADE UNIQUE,
  guesty_client_id TEXT NOT NULL,
  guesty_client_secret TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- Properties (per account, multiple per account)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS properties (
  id SERIAL PRIMARY KEY,
  account_id INT REFERENCES accounts(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  welcome_message TEXT DEFAULT 'Welcome!',
  logo_url TEXT DEFAULT '',
  brand_color VARCHAR(7) DEFAULT '#2C3E50',
  accent_color VARCHAR(7) DEFAULT '#E67E22',
  fallback_phone VARCHAR(50) DEFAULT '',
  guesty_guest_app_name VARCHAR(255) DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(account_id, slug)
);

-- ─────────────────────────────────────────────
-- Check-in lookup log (for analytics)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS checkin_logs (
  id SERIAL PRIMARY KEY,
  property_id INT REFERENCES properties(id) ON DELETE SET NULL,
  account_id INT REFERENCES accounts(id) ON DELETE SET NULL,
  guest_last_name VARCHAR(255),
  result VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkin_logs_account ON checkin_logs(account_id);
CREATE INDEX IF NOT EXISTS idx_checkin_logs_property ON checkin_logs(property_id);
CREATE INDEX IF NOT EXISTS idx_checkin_logs_created ON checkin_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_properties_account ON properties(account_id);
CREATE INDEX IF NOT EXISTS idx_accounts_slug ON accounts(slug);
