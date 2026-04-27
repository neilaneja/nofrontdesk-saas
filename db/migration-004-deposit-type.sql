-- Migration 004: Add deposit_type to properties
-- Allows properties to choose between 'charge' (immediate) and 'hold' (pre-auth)

ALTER TABLE properties ADD COLUMN IF NOT EXISTS deposit_type VARCHAR(20) DEFAULT 'charge';
