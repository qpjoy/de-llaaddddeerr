-- Platform-wide windowed analytics; existing indexes lead with consumer/request.
CREATE INDEX IF NOT EXISTS connector_calls_started_at_idx
  ON serving.connector_calls (started_at DESC)
  WHERE operation IN ('raw', 'crawl', 'user-info');
