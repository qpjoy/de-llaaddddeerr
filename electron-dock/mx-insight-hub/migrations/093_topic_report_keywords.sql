ALTER TABLE insights.topic_reports ADD COLUMN IF NOT EXISTS keywords text[] NOT NULL DEFAULT '{}';
ALTER TABLE insights.topic_reports ADD COLUMN IF NOT EXISTS match_mode text NOT NULL DEFAULT 'any' CHECK (match_mode IN ('any', 'all'));
CREATE INDEX IF NOT EXISTS topic_reports_consumer_created_idx ON insights.topic_reports (consumer_id, created_at DESC, id DESC);
