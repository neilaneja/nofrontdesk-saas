-- Migration 005: Create guest_payments table
-- Tracks security deposits collected via Stripe during check-in

CREATE TABLE IF NOT EXISTS guest_payments (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  property_id INTEGER NOT NULL REFERENCES properties(id),
  guest_name VARCHAR(255),
  guest_email VARCHAR(255),
  type VARCHAR(20) NOT NULL DEFAULT 'charge',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  stripe_payment_intent_id VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_guest_payments_account ON guest_payments(account_id);
CREATE INDEX IF NOT EXISTS idx_guest_payments_property ON guest_payments(property_id);
CREATE INDEX IF NOT EXISTS idx_guest_payments_status ON guest_payments(status);
