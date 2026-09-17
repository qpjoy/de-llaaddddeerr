-- Optional, validated Hub request body for explicit Admin comparison runs.
-- Contains no authorization headers or provider credentials; historical rows stay NULL.
ALTER TABLE public.usage_requests
  ADD COLUMN IF NOT EXISTS acquisition_request jsonb
  CHECK (acquisition_request IS NULL OR jsonb_typeof(acquisition_request) = 'object');
