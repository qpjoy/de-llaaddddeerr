-- Two omitted emotion labels verified in request 7316edc1. Update comparison
-- only, then repair its two still-current previews from existing paid receipts.
-- No upstream call, new grant/charge, restricted-response copy or replay rewrite.
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION core.weibo_display_comparison_text(body text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT regexp_replace(regexp_replace(regexp_replace(body,
    '#([^#\[\]\r\n]+)\[超话\]#', '\1超话', 'g'),
    '|\[(笑cry|打call|兔子|哈哈)\]', '', 'g'), '[[:space:]​﻿]', '', 'g');
$fn$;

-- Older queued Hub rows carry the top-level body_completeness field seen in
-- this incident. Both forms are explicit previews; the existing trigger's
-- verified-full-text/dataset scope and all identity guards still apply.
CREATE OR REPLACE FUNCTION core.preserve_hub_raw_weibo_full_text()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.deleted_at IS NULL AND OLD.deleted_at IS NULL
     AND NEW.dataset_id = OLD.dataset_id AND NEW.platform = OLD.platform
     AND NEW.object_type = OLD.object_type AND NEW.external_id = OLD.external_id
     AND NEW.author_external_id IS NOT DISTINCT FROM OLD.author_external_id
     AND (core.weibo_long_text_preview_of(OLD.body, NEW.body)
       OR ((NEW.extensions #>> '{rawSearch,bodyCompleteness}' = 'provider_preview'
           OR NEW.extensions->>'body_completeness' = 'provider_preview')
         AND core.weibo_display_preview_of(OLD.body, NEW.body))) THEN
    OLD.last_seen_at := GREATEST(OLD.last_seen_at, NEW.last_seen_at);
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;

DO $repair$
DECLARE
  original_request_id constant uuid := '7316edc1-9479-4c17-b8ae-7cf0796493af';
  search_call constant uuid := '02728998-f37a-4c8f-a35b-f9f48af00685';
  parser constant text := 'mxih-weibo-emotion-repair.v1';
  target record;
  current_record core.canonical_records%ROWTYPE;
  receipt record;
  payload jsonb;
  full_body text;
  evidence jsonb;
  next_extensions jsonb;
  content_hash text;
  run_id uuid;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('5351931117044493', '869086b1-9f9b-4359-b9d4-ea42df24a873'::uuid,
      'f3ebb9cf-746c-4e2a-a428-30fdbce41769'),
    ('5351932359082259', '88000ff3-0f4d-4076-b159-a91b588b06e3'::uuid,
      'a4494989-4efb-4526-a580-4a6641e87fb8')
  ) AS targets(post_id, call_id, upstream_request_id) LOOP
    SELECT * INTO current_record FROM core.canonical_records
      WHERE dataset_id = 'night-all.search.v1' AND platform = 'weibo'
        AND object_type = 'post' AND external_id = target.post_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE NOTICE 'Weibo emotion repair skipped %: record absent', target.post_id;
      CONTINUE;
    END IF;
    IF current_record.extensions #>> '{weiboLongTextRepair,parserVersion}' = parser THEN
      CONTINUE;
    END IF;
    -- Never overwrite a subsequent edit/deletion, a different author, or a
    -- record not actually observed in the diagnosed Hub search request.
    IF current_record.deleted_at IS NOT NULL OR current_record.current_revision <> 1
      OR current_record.author_external_id IS DISTINCT FROM '7851053384'
      OR NOT EXISTS (SELECT 1 FROM core.observations o
        JOIN ingest.ingest_runs r ON r.id = o.ingest_run_id
        WHERE o.record_id = current_record.id AND r.request_id = original_request_id
          AND r.external_platform_call_id = search_call) THEN
      RAISE NOTICE 'Weibo emotion repair skipped %: current identity/revision/lineage changed', target.post_id;
      CONTINUE;
    END IF;
    SELECT a.body_bytes, a.body_size, a.body_sha256, a.captured_at INTO receipt
      FROM control.external_platform_restricted_raw_responses a
      JOIN external_platform.provider_calls p ON p.id = a.provider_call_id
      WHERE p.id = target.call_id AND p.usage_request_id = original_request_id
        AND p.upstream_request_id = target.upstream_request_id
        AND p.provider_key = 'tikhub' AND p.outcome = 'succeeded'
        AND p.http_status = 200 AND p.business_code = 200
        AND p.operation = 'native.t.api_4f35621a9c07e539'
        AND p.endpoint_key = p.operation
        AND p.contract_version = 'mx-insight-hub.native-forwarding.v1'
        AND p.dispatch_fingerprint = encode(sha256(convert_to(
          '{"version":"weibo-full-text.v1","id":"' || target.post_id || '"}', 'UTF8')), 'hex')
        AND a.body_size <= 8388608;
    IF NOT FOUND THEN
      RAISE NOTICE 'Weibo emotion repair skipped %: correlated receipt unavailable', target.post_id;
      CONTINUE;
    END IF;
    IF octet_length(receipt.body_bytes) <> receipt.body_size
      OR encode(sha256(receipt.body_bytes), 'hex') IS DISTINCT FROM btrim(receipt.body_sha256) THEN
      RAISE EXCEPTION 'Weibo emotion repair refused %: receipt integrity mismatch', target.post_id;
    END IF;
    payload := convert_from(receipt.body_bytes, 'UTF8')::jsonb;
    full_body := btrim(payload #>> '{data,longText,content}', E' \t\r\n' || chr(160) || chr(65279));
    -- This targeted SQL repair accepts plain longText only. Do not invent an
    -- HTML normalizer here; unsupported evidence remains available to operators.
    IF payload->'code' IS DISTINCT FROM '200'::jsonb
      OR payload #>> '{data,idstr}' IS DISTINCT FROM target.post_id
      OR coalesce(payload #>> '{data,user,idstr}', payload #>> '{data,user,id}') IS DISTINCT FROM '7851053384'
      OR jsonb_typeof(payload #> '{data,longText,content}') IS DISTINCT FROM 'string'
      OR full_body IS NULL OR char_length(full_body) <= char_length(current_record.body)
      OR full_body ~ '<[^>]*>|&(#([xX][0-9A-Fa-f]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp);'
      OR full_body ~ '(展开(全文)?[[:space:]]*[cCＣｃ]?|…|[.]{3})[[:space:]​﻿]*$'
      OR core.weibo_display_preview_of(full_body, current_record.body) IS DISTINCT FROM true THEN
      RAISE NOTICE 'Weibo emotion repair skipped %: full text does not validate against current preview', target.post_id;
      CONTINUE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM core.record_revisions WHERE record_id = current_record.id
      AND revision = current_record.current_revision AND payload_sha256 = current_record.payload_sha256) THEN
      RAISE EXCEPTION 'Weibo emotion repair refused %: inconsistent revision history', target.post_id;
    END IF;
    evidence := jsonb_build_object('parserVersion', parser, 'comparisonPolicy', 'weibo_display_v2',
      'requestId', original_request_id, 'providerCallId', target.call_id, 'upstreamRequestId', target.upstream_request_id,
      'responseSha256', btrim(receipt.body_sha256), 'capturedAt', receipt.captured_at,
      'previousRevision', current_record.current_revision, 'previousPayloadSha256', current_record.payload_sha256,
      'migration', '136_weibo_emotion_full_text_repair.sql');
    next_extensions := current_record.extensions || jsonb_build_object('weiboLongTextRepair', evidence,
      'body_completeness', 'full_text', 'rawSearch', jsonb_build_object(
        'version', 'mx-insight-hub.raw-search.v1', 'bodyCompleteness', 'full_text'));
    content_hash := encode(sha256(convert_to(jsonb_build_object('body', full_body, 'title', current_record.title,
      'previousPayloadSha256', current_record.payload_sha256, 'extensions', next_extensions)::text, 'UTF8')), 'hex');
    run_id := gen_random_uuid();
    -- A new manual run: attaching it to the old customer request would alter
    -- acquisition-history membership. Keep the receipt reference in evidence.
    INSERT INTO ingest.ingest_runs(id, connector_id, stream_id, trigger, item_count, finished_at)
      VALUES(run_id, 'ops:weibo-emotion-repair', 'weibo-posts', 'manual_full_text_repair', 1, now());
    UPDATE core.canonical_records SET body = full_body, extensions = next_extensions,
      payload_sha256 = content_hash, current_revision = current_revision + 1,
      projection_revision = projection_revision + 1
      WHERE id = current_record.id RETURNING * INTO current_record;
    INSERT INTO core.record_revisions(record_id, revision, payload_sha256, normalized_payload, parser_version, ingest_run_id)
      VALUES(current_record.id, current_record.current_revision, content_hash, to_jsonb(current_record), parser, run_id);
    INSERT INTO core.observations(id, record_id, connector_id, source_event_id, observation_hash, ingest_run_id)
      VALUES(gen_random_uuid(), current_record.id, 'ops:weibo-emotion-repair', target.call_id::text,
        btrim(receipt.body_sha256), run_id);
    INSERT INTO outbox.projection_events(aggregate_type, aggregate_id, event_type, projection_revision, payload)
      VALUES('canonical_record', current_record.id, 'upsert', current_record.projection_revision,
        jsonb_build_object('datasetId', current_record.dataset_id, 'platform', 'weibo', 'objectType', 'post'));
    RAISE NOTICE 'Weibo emotion repair applied %: % characters, revision %',
      target.post_id, char_length(full_body), current_record.current_revision;
  END LOOP;
END
$repair$;
