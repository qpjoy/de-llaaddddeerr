-- New business source identities only; do not overwrite operator coverage or name ownership.
WITH added AS (
 INSERT INTO catalog.source_catalog_entries (id,source_key,canonical_name,major_category,scenarios,regions,coverage_status,delivery_status,review_status,runtime_status,notes,imported_from)
 SELECT id::uuid,source_key,name,category,ARRAY['内容/舆情/评论监测'],ARRAY[region],'unknown','planned','needs_review','not_configured','已登记接口合同；运行和数据覆盖需独立核验。','official-contracts-2026-09-27'
 FROM (VALUES
 ('983003f6-3d36-5c02-affe-5a5649d49396','source-platform-lemon8','Lemon8','海外社媒与内容平台','全球'),
 ('18393b32-c57a-5c46-abb6-4c245a9ec6dc','source-platform-pipixia','皮皮虾','国内社媒与内容平台','中国大陆'),
 ('53e6bd69-f5d7-5a8b-a684-0365657a973a','source-platform-youku','优酷','国内社媒与内容平台','中国大陆'),
 ('ec3c410f-9b20-53e0-a26e-7e5dcee2faeb','source-platform-imdb','IMDb','海外社媒与内容平台','全球'),
 ('c5aef368-5f23-5b60-ad43-dfb633850eb3','source-platform-vcg','视觉中国','国内社媒与内容平台','中国大陆'),
 ('28431f5d-3cc6-5730-aba8-4a7478f42761','source-platform-pixabay','Pixabay','海外社媒与内容平台','全球'),
 ('26a55fcf-a96e-5937-a703-08b590a3456f','source-platform-qq-huxuan','腾讯互选','国内社媒与内容平台','中国大陆'),
 ('a1fadcff-c3d5-50ba-a3be-46dd66869e03','source-platform-douyin-xingtu','巨量星图','国内社媒与内容平台','中国大陆')
 ) AS candidate(id,source_key,name,category,region)
 WHERE NOT EXISTS (SELECT 1 FROM catalog.source_catalog_entry_names n WHERE n.normalized_name=lower(btrim(normalize(candidate.name,NFKC))))
 ON CONFLICT DO NOTHING RETURNING *
) INSERT INTO catalog.source_catalog_events (id,entry_id,event_type,actor,to_revision,changes)
SELECT gen_random_uuid(),id,'imported','migration-115',revision,jsonb_build_object('sourceKey',source_key,'evidence','official-contracts-2026-09-27') FROM added;

INSERT INTO catalog.source_catalog_entry_names (normalized_name,entry_id,display_name,name_kind)
SELECT lower(btrim(normalize(canonical_name,NFKC))),id,canonical_name,'canonical' FROM catalog.source_catalog_entries WHERE imported_from='official-contracts-2026-09-27'
ON CONFLICT DO NOTHING;
