-- Saved-record categories are registered dynamically. Keep the admitted grant
-- snapshot nonempty without limiting reports to the original thirteen sources.
-- Authorization remains in the report service; existing snapshots are unchanged.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

ALTER TABLE insights.topic_reports
  DROP CONSTRAINT IF EXISTS topic_reports_authorized_platforms_check,
  ADD CONSTRAINT topic_reports_authorized_platforms_check
    CHECK (cardinality(authorized_platforms) >= 1);
