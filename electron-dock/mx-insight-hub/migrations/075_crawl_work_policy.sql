-- Preserve existing consumer limits; increasing crawl work is an operator action.
ALTER TABLE consumer_platform_policies ADD COLUMN max_crawl_work integer;
UPDATE consumer_platform_policies SET max_crawl_work = LEAST(max_page_size, 100);
ALTER TABLE consumer_platform_policies
  ALTER COLUMN max_crawl_work SET DEFAULT 100,
  ALTER COLUMN max_crawl_work SET NOT NULL,
  ADD CONSTRAINT consumer_platform_crawl_work_bounds CHECK (max_crawl_work BETWEEN 1 AND 5000);
