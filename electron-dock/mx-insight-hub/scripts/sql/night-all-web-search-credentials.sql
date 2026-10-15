-- Read only. $1 is the validated Hub Web Search provider key array.
-- $2 is the validated optional explicit provider/module bindings as JSON.
-- Without an override, resolve an active module first, then the default provider.
-- Explicit bindings use an exact pair and never fall back to a default.
-- Secrets are consumed in memory by migrate-web-search-credentials.mjs; never
-- run this query in a terminal that prints its result or exports it to a log.
select requested.provider as hub_provider,
       chosen.secret, chosen.module_code, chosen.base_url, chosen.host
  from unnest($1::text[]) as requested(provider)
  left join jsonb_to_recordset($2::jsonb)
    as binding(hub_provider text, credential_provider text, module_code text)
    on binding.hub_provider = requested.provider
  left join lateral (
    select c.secret, m.module_code, m.base_url, m.host
      from public.credential_modules m
      join public.provider_credentials c on c.id = m.credential_id
     where m.active = true and c.status = 'active'
       and ((binding.credential_provider is not null
             and c.provider = binding.credential_provider and m.module_code = binding.module_code)
         or (binding.credential_provider is null
             and (m.module_code = requested.provider or c.provider = requested.provider)))
     order by (m.module_code = requested.provider) desc,
              (m.module_code = c.provider) desc, m.updated_at desc, c.id, m.id
     limit 1
  ) chosen on true
