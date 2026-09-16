-- Qixin is optional, disabled by default. No tenant/Key grants or paid calls.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
INSERT INTO external_platform.provider_state (provider_key) VALUES ('qixin') ON CONFLICT DO NOTHING;
INSERT INTO control.external_platform_provider_settings (provider_key) VALUES ('qixin') ON CONFLICT DO NOTHING;
INSERT INTO control.external_platform_provider_price_books (provider_key, version, source, status)
VALUES ('qixin', 0, 'legacy_environment', 'inherited') ON CONFLICT DO NOTHING;

-- Explicit zero prices only for the five free report/result APIs in the pinned
-- catalog, and only after an Admin review. Other providers retain positive prices.
DO $guard$
DECLARE row record;
BEGIN
  FOR row IN SELECT conname FROM pg_constraint
    WHERE conrelid = 'control.external_platform_provider_price_book_entries'::regclass
      AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%unit_cost_minor%'
  LOOP
    EXECUTE format('ALTER TABLE control.external_platform_provider_price_book_entries DROP CONSTRAINT %I', row.conname);
  END LOOP;
END $guard$;
ALTER TABLE control.external_platform_provider_price_book_entries ADD CONSTRAINT provider_price_unit_guard
  CHECK (unit_cost_minor BETWEEN 1 AND 9007199254740991 OR
    (unit_cost_minor = 0 AND provider_key = 'qixin' AND endpoint_key IN ('enterprise.36.99','enterprise.22.62','enterprise.2.3','enterprise.60.2','enterprise.33.11')));

CREATE OR REPLACE FUNCTION control.enforce_external_platform_active_price_book()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.control_source = 'database'
     AND NEW.desired_state IN ('active', 'canary')
     AND NOT EXISTS (
       SELECT 1
         FROM control.external_platform_operation_releases release
         JOIN control.external_platform_provider_price_books price
           ON price.provider_key = release.provider_key
          AND price.version = release.price_book_version
        WHERE release.provider_key = NEW.provider_key
          AND release.operation_key = NEW.operation_key
          AND release.release_revision = NEW.release_revision
          AND release.status = 'released'
          AND price.source = 'database'
          AND price.status = 'reviewed'
          AND NOT EXISTS (
            SELECT 1
              FROM unnest(release.endpoint_keys) endpoint_key
             WHERE NOT EXISTS (
               SELECT 1
                 FROM control.external_platform_provider_price_book_entries entry
                WHERE entry.provider_key = price.provider_key
                  AND entry.price_book_version = price.version
                  AND entry.endpoint_key = endpoint_key
                  AND (entry.unit_cost_minor > 0 OR (entry.provider_key = 'qixin' AND entry.unit_cost_minor = 0))
             )
          )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'database active/canary policy requires a reviewed positive price book';
  END IF;
  RETURN NEW;
END
$function$;

INSERT INTO control.external_platform_operation_releases
 (provider_key, operation_key, release_revision, contract_version, endpoint_keys, price_book_version, status, created_by)
VALUES
 ('qixin', 'enterprise.api.47.51', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.47.51'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.55.29', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.55.29'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.51.17', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.51.17'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.55.82', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.55.82'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.36.99', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.36.99'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.35.86', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.35.86'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.22.62', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.22.62'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.31', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.31'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.2', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.2'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.21.92', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.21.92'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.19.91', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.19.91'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.41', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.41'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.36', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.36'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.43', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.43'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.37.17', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.37.17'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.57.18', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.57.18'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.50', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.50'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.34.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.34.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.45', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.45'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.8', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.8'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.47', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.47'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.51', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.51'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.49', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.49'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.18', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.18'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.53', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.53'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.3.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.3.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.16', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.16'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.17', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.17'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.3.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.3.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.32', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.32'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.91.59', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.91.59'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.27', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.27'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.30', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.30'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.35.2', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.35.2'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.47.96', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.47.96'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.36.2', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.36.2'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.88.49', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.88.49'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.46.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.46.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.59.5', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.59.5'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.2.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.2.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.2.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.2.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.60.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.60.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.60.2', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.60.2'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.42.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.42.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.42.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.42.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.42.4', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.42.4'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.42.9', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.42.9'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.93.16', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.93.16'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.93.17', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.93.17'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.11', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.11'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.12', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.12'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.13', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.13'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.34', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.34'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.26', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.26'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.24.28', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.24.28'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.21.47', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.21.47'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.91.66', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.91.66'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.64.13', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.64.13'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.51.39', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.51.39'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.77.51', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.77.51'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.47.4', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.47.4'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.17.5', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.17.5'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.5.5', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.5.5'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.19.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.19.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.9.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.9.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.62.89', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.62.89'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.6.5', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.6.5'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.66.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.66.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.7.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.7.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.51.4', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.51.4'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.51.5', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.51.5'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.61.75', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.61.75'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.98.98', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.98.98'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.6.6', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.6.6'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.6.4', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.6.4'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.85.71', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.85.71'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.18.39', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.18.39'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.27.59', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.27.59'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.39.38', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.39.38'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.99.68', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.99.68'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.16.53', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.16.53'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.32.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.32.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.67.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.67.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.25.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.25.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.26.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.26.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.34.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.34.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.55', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.55'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.56.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.56.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.20.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.20.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.20.11', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.20.11'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.63.2', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.63.2'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.20.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.20.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.17', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.17'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.35', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.35'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.22.8', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.22.8'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.12.5', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.12.5'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.51.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.51.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.51.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.51.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.66.36', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.66.36'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.66.34', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.66.34'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.66.35', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.66.35'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.66.56', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.66.56'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.40.2', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.40.2'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.36.53', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.36.53'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.69.75', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.69.75'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.23.47', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.23.47'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.39.2', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.39.2'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.38.2', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.38.2'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.52.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.52.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.21.4', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.21.4'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.21.6', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.21.6'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.11.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.11.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.53.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.53.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.76.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.76.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.52.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.52.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.43.4', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.43.4'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.43.5', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.43.5'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.38.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.38.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.16', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.16'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.15', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.15'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.32', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.32'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.31', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.31'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.33', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.33'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.66.33', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.66.33'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.95.16', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.95.16'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.57.83', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.57.83'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.88.24', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.88.24'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.36.38', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.36.38'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.96.51', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.96.51'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.15.72', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.15.72'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.23.48', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.23.48'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.52.68', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.52.68'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.37', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.37'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.12.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.12.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.12.4', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.12.4'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.8.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.8.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.8.4', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.8.4'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.25', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.25'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.24', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.24'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.14.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.14.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.15.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.15.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.16.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.16.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.22.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.22.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.22.11', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.22.11'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.21', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.21'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.22.6', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.22.6'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.22.10', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.22.10'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.22.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.22.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.22.4', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.22.4'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.22.5', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.22.5'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.51.71', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.51.71'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.15.44', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.15.44'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.41.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.41.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.55.5', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.55.5'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.77.76', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.77.76'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.33.13', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.33.13'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.44.2', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.44.2'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.55.2', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.55.2'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.33.15', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.33.15'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.2.53', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.2.53'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.28.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.28.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.28.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.28.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.33.12', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.33.12'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.33.9', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.33.9'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.45.93', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.45.93'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.33.10', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.33.10'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.33.11', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.33.11'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.22.36', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.22.36'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.61.77', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.61.77'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.33.14', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.33.14'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.62.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.62.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.27.39', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.27.39'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.12.62', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.12.62'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.13', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.13'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.30.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.30.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.30.4', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.30.4'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.55.55', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.55.55'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.82.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.82.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.82.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.82.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.22', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.22'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.23', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.23'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.66.21', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.66.21'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.83.52', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.83.52'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.91.74', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.91.74'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.95.03', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.95.03'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.86.83', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.86.83'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.98.85', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.98.85'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.65.48', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.65.48'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.72.51', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.72.51'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.82.11', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.82.11'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.14', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.14'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.82.10', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.82.10'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.82.12', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.82.12'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.1.25', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.1.25'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.44.82', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.44.82'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.89.95', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.89.95'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.10.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.10.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.10.4', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.10.4'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.37.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.37.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.50.5', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.50.5'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.49.5', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.49.5'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.48.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.48.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.66.28', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.66.28'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.39', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.39'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.83.58', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.83.58'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.77.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.77.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.77.2', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.77.2'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.79.41', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.79.41'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.31.29', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.31.29'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.83.2', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.83.2'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.83.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.83.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.61.45', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.61.45'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.43.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.43.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.2', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.2'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.4', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.4'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.5', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.5'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.6', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.6'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.7', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.7'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.8', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.8'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.9', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.9'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.10', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.10'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.11', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.11'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.12', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.12'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.13', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.13'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.14', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.14'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.15', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.15'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.17', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.17'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.20', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.20'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.18', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.18'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.68.19', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.68.19'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.43.2', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.43.2'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.58.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.58.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.72.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.72.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.72.2', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.72.2'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.72.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.72.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.72.4', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.72.4'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.72.5', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.72.5'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.72.6', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.72.6'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.72.7', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.72.7'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.72.8', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.72.8'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.72.9', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.72.9'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.72.10', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.72.10'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.72.11', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.72.11'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.72.12', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.72.12'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.72.13', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.72.13'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.69.21', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.69.21'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.69.22', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.69.22'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.72.14', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.72.14'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.86.42', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.86.42'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.27.35', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.27.35'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.47.26', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.47.26'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.52.86', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.52.86'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.80.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.80.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.80.5', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.80.5'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.80.6', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.80.6'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.71.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.71.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.71.3', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.71.3'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.71.5', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.71.5'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.71.7', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.71.7'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.71.11', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.71.11'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.71.13', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.71.13'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.71.15', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.71.15'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.71.17', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.71.17'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.71.19', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.71.19'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.71.21', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.71.21'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.71.23', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.71.23'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.71.25', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.71.25'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.71.27', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.71.27'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.61.1', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.61.1'], 0, 'released', 'migration-091'),
 ('qixin', 'enterprise.api.98.12', 1, 'mx-insight-hub.enterprise-query.v1', ARRAY['enterprise.98.12'], 0, 'released', 'migration-091')
ON CONFLICT DO NOTHING;
INSERT INTO control.external_platform_operation_policies
 (provider_key, operation_key, release_revision, control_source, desired_state)
 SELECT provider_key, operation_key, release_revision, 'legacy_environment', 'disabled'
 FROM control.external_platform_operation_releases WHERE provider_key = 'qixin' AND release_revision = 1
 ON CONFLICT DO NOTHING;
