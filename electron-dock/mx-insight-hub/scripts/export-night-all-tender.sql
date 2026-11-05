-- Stream active, cleaned tender records to the psql client's stdout.
COPY (
  SELECT id AS hub_id, external_id AS record_key, title, url, body,
         event_time AS published_at, collected_at AS source_first_seen_at,
         stable_fields #>> '{crawler,identity,rowId}' AS source_row_id,
         stable_fields, extensions
  FROM core.canonical_records
  WHERE dataset_id = 'data-center.saved-records.tender.v1'
    AND platform = 'data_center_saved_records_tender'
    AND object_type = 'saved_record'
    AND deleted_at IS NULL
  ORDER BY external_id
) TO STDOUT WITH (FORMAT csv, HEADER true);
