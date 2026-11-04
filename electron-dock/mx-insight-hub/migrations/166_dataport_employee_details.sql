-- Employee contact details and owner-only current credential viewing.
-- Existing hashes cannot be reversed; retain only recoverable initial ciphertext.
ALTER TABLE dataport.managed_accounts ADD COLUMN email text
  CHECK (email IS NULL OR (email = lower(btrim(email)) AND length(email) <= 254 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'));
CREATE UNIQUE INDEX dataport_employee_email_unique ON dataport.managed_accounts(email) WHERE email IS NOT NULL;
ALTER TABLE dataport.local_credentials ADD COLUMN password_cipher jsonb;
UPDATE dataport.local_credentials SET password_cipher=initial_cipher WHERE initial_cipher IS NOT NULL;
