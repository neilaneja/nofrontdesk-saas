-- Migration 003: Stripe Connect + Guest Payments
-- Run with: psql $DATABASE_URL -f db/migration-003-payments.sql

-- Add Stripe Connect fields to accounts
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS stripe_connect_id VARCHAR(255);
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS stripe_connect_onboarded BOOLEAN DEFAULT FALSE;

-- Add payment settings to properties
ALTER TABLE properties ADD COLUMN IF NOT EXISTS deposit_amount_cents INT DEFAULT 0;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS deposit_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS payment_description TEXT DEFAULT 'Security Deposit';

-- Guest payments table
CREATE TABLE IF NOT EXISTS guest_payments (
  id SERIAL PRIMARY KEY,
  account_id INT REFERENCES accounts(id) ON DELETE CASCADE,
  property_id INT REFERENCES properties(id) ON DELETE SET NULL,
  guest_name VARCHAR(255),
  guest_email VARCHAR(255),
  reservation_id VARCHAR(255),
  type VARCHAR(50) NOT NULL DEFAULT 'charge',
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  amount_cents INT NOT NULL,
  currency VARCHAR(10) DEFAULT 'usd',
  description TEXT,
  stripe_payment_intent_id VARCHAR(255),
  stripe_charge_id VARCHAR(255),
  stripe_refund_id VARCHAR(255),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guest_payments_account ON guest_payments(account_id);
CREATE INDEX IF NOT EXISTS idx_guest_payments_property ON guest_payments(property_id);
CREATE INDEX IF NOT EXISTS idx_guest_payments_status ON guest_payments(status);
CREATE INDEX IF NOT EXISTS idx_guest_payments_reservation ON guest_payments(reservation_id);
CREATE INDEX IF NOT EXISTS idx_guest_payments_stripe_pi ON guest_payments(stripe_payment_intent_id);
