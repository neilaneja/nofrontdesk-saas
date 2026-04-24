-- âââââââââââââââââââââââââââââââââââââââââââââ
-- Multi-PMS Migration
-- Adds support for multiple PMS platforms
-- Run this AFTER the confirmation code migration
-- âââââââââââââââââââââââââââââââââââââââââââââ

-- Step 1: Add pms_type column to api_credentials
ALTER TABLE api_credentials ADD COLUMN IF NOT EXISTS pms_type VARCHAR(50) DEFAULT 'guesty';

-- Step 2: Add generic credentials JSON column
-- Stores PMS-specific credentials as JSON (flexible per PMS type)
ALTER TABLE api_credentials ADD COLUMN IF NOT EXISTS credentials JSONB DEFAULT '{}';

-- Step 3: Migrate existing Guesty credentials to the new JSON format
UPDATE api_credentials
SET credentials = jsonb_build_object(
  'clientId', guesty_client_id,
  'clientSecret', guesty_client_secret
),
pms_type = 'guesty'
WHERE guesty_client_id IS NOT NULL
  AND (credentials IS NULL OR credentials = '{}');

-- Step 4: Add custom_domain column to properties (for custom domain mapping)
ALTER TABLE properties ADD COLUMN IF NOT EXISTS custom_domain VARCHAR(255) DEFAULT '';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS custom_domain_verified BOOLEAN DEFAULT false;

-- Step 5: Add embed_enabled column to properties (for widget embedding)
ALTER TABLE properties ADD COLUMN IF NOT EXISTS embed_enabled BOOLEAN DEFAULT true;

-- Step 6: Indexes
CREATE INDEX IF NOT EXISTS idx_api_credentials_pms_type ON api_credentials(pms_type);
CREATE INDEX IF NOT EXISTS idx_properties_custom_domain ON properties(custom_domain) WHERE custom_domain != '';

-- Step 7: Note - guesty_client_id and guesty_client_secret columns can be dropped
-- after confirming the migration worked. For now, keep them as backup.
-- ALTER TABLE api_credentials DROP COLUMN IF EXISTS guesty_client_id;
-- ALTER TABLE api_credentials DROP COLUMN IF EXISTS guesty_client_secret;
