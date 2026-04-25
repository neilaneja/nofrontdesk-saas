-- Migration 002: Add check-in form configuration
-- Run with: psql $DATABASE_URL -f db/migration-002-checkin-form.sql

-- âââââââââââââââââââââââââââââââââââââââââââââ
-- Update api_credentials to support multiple PMS types
-- (Already handled in previous migration with pms_type + credentials JSONB)
-- âââââââââââââââââââââââââââââââââââââââââââââ

-- âââââââââââââââââââââââââââââââââââââââââââââ
-- Add check-in form configuration to properties
-- âââââââââââââââââââââââââââââââââââââââââââââ
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS checkin_form_mode VARCHAR(20) DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS custom_checkin_url TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS require_confirmation_code BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS checkin_form_config JSONB DEFAULT '{
    "enabled_sections": {
      "guest_info": true,
      "id_verification": true,
      "selfie": false,
      "signature": true,
      "house_rules": true,
      "rental_agreement": false,
      "vehicle_info": false,
      "arrival_info": true,
      "custom_questions": false,
      "payment_auth": false
    },
    "guest_info_fields": {
      "full_name": { "enabled": true, "required": true },
      "email": { "enabled": true, "required": true },
      "phone": { "enabled": true, "required": true },
      "address": { "enabled": true, "required": false },
      "num_guests": { "enabled": true, "required": true },
      "num_adults": { "enabled": false, "required": false },
      "num_children": { "enabled": false, "required": false }
    },
    "id_verification": {
      "require_front": true,
      "require_back": false,
      "accepted_types": ["passport", "drivers_license", "national_id"],
      "max_file_size_mb": 10
    },
    "arrival_info": {
      "ask_eta": true,
      "ask_flight_info": false,
      "ask_special_requests": true
    },
    "house_rules": {
      "rules_text": "",
      "require_acknowledgment": true
    },
    "rental_agreement": {
      "agreement_text": "",
      "require_signature": true
    },
    "custom_questions": [],
    "vehicle_info": {
      "ask_make_model": true,
      "ask_license_plate": true,
      "ask_color": false
    },
    "completion_message": "You are all checked in! We look forward to hosting you.",
    "redirect_after_submit": ""
  }'::jsonb;

-- âââââââââââââââââââââââââââââââââââââââââââââ
-- Store check-in form submissions
-- âââââââââââââââââââââââââââââââââââââââââââââ
CREATE TABLE IF NOT EXISTS checkin_submissions (
  id SERIAL PRIMARY KEY,
  property_id INT REFERENCES properties(id) ON DELETE SET NULL,
  account_id INT REFERENCES accounts(id) ON DELETE SET NULL,
  reservation_id VARCHAR(255),
  pms_type VARCHAR(50),
  guest_first_name VARCHAR(255),
  guest_last_name VARCHAR(255),
  guest_email VARCHAR(255),
  guest_phone VARCHAR(50),
  guest_address TEXT,
  num_guests INT,
  arrival_eta VARCHAR(100),
  flight_info VARCHAR(255),
  special_requests TEXT,
  vehicle_make_model VARCHAR(255),
  vehicle_license_plate VARCHAR(100),
  vehicle_color VARCHAR(50),
  house_rules_accepted BOOLEAN DEFAULT FALSE,
  rental_agreement_signed BOOLEAN DEFAULT FALSE,
  signature_data TEXT,
  custom_answers JSONB DEFAULT '{}',
  id_front_url TEXT,
  id_back_url TEXT,
  selfie_url TEXT,
  status VARCHAR(20) DEFAULT 'submitted',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkin_submissions_account ON checkin_submissions(account_id);
CREATE INDEX IF NOT EXISTS idx_checkin_submissions_property ON checkin_submissions(property_id);
CREATE INDEX IF NOT EXISTS idx_checkin_submissions_reservation ON checkin_submissions(reservation_id);

-- âââââââââââââââââââââââââââââââââââââââââââââ
-- Store uploaded files (ID photos, selfies)
-- âââââââââââââââââââââââââââââââââââââââââââââ
CREATE TABLE IF NOT EXISTS checkin_uploads (
  id SERIAL PRIMARY KEY,
  submission_id INT REFERENCES checkin_submissions(id) ON DELETE CASCADE,
  file_type VARCHAR(20) NOT NULL, -- 'id_front', 'id_back', 'selfie', 'signature'
  file_name VARCHAR(255),
  file_url TEXT NOT NULL,
  file_size INT,
  mime_type VARCHAR(100),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checkin_uploads_submission ON checkin_uploads(submission_id);
