-- Explicitly authorized 2026-10-10: retain the original secret, billing,
-- lifecycle and snapshot ownership; deployments keep its business scopes current.
ALTER TABLE api_keys ADD COLUMN access_profile text NOT NULL DEFAULT 'standard'
  CHECK (access_profile IN ('standard', 'managed_full'));

DO $profile$
DECLARE selected_key api_keys%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tenant-access:277bf8a4-5ed5-414d-b429-d72fcd7d36b6'));
  SELECT * INTO selected_key FROM api_keys WHERE id='fd2f8cc9-0ff1-4052-a538-8cc8150bde83' FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF selected_key.tenant_id <> '277bf8a4-5ed5-414d-b429-d72fcd7d36b6'
     OR selected_key.consumer_id <> 'be7d07fe-3d98-4db3-b00d-e5cbe5a76190'
     OR selected_key.scope_mode <> 'snapshot' OR selected_key.environment <> 'live'
     OR selected_key.status <> 'active' OR selected_key.expires_at <= now() THEN
    RAISE EXCEPTION 'LCY managed access refused: original identity unavailable';
  END IF;
  UPDATE api_keys SET access_profile='managed_full' WHERE id=selected_key.id;
  INSERT INTO api_key_scope_events(api_key_id,actor,previous_scopes,next_scopes)
    VALUES(selected_key.id,'migration-141:user-authorized-full-business-access',
      jsonb_build_object('accessProfile','standard'), jsonb_build_object('accessProfile','managed_full','quotaExempt',true));
END
$profile$;
