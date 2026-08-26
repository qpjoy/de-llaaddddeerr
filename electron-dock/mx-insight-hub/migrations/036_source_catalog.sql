-- Deterministic governed source catalog generated from spec_docs/data_source.
-- Regenerate with: npm run generate:source-catalog
--   01.support_platform.txt: 9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c
--   02.base.txt: 79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b
--   02.fugai.txt: 0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82
--   02.weifugai.txt: be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059
--   03.txt: a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd

CREATE SCHEMA IF NOT EXISTS catalog;

CREATE TABLE IF NOT EXISTS catalog.source_catalog_entries (
  id uuid PRIMARY KEY,
  source_key text NOT NULL UNIQUE
    CHECK (source_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  legacy_sequence integer UNIQUE CHECK (legacy_sequence > 0),
  canonical_name text NOT NULL CHECK (length(btrim(canonical_name)) BETWEEN 1 AND 160),
  aliases text[] NOT NULL DEFAULT ARRAY[]::text[],
  source_kind text NOT NULL DEFAULT 'platform'
    CHECK (source_kind IN ('platform', 'platform_module', 'source_class', 'registry', 'provider', 'dataset', 'other')),
  parent_source_id uuid REFERENCES catalog.source_catalog_entries(id) ON DELETE RESTRICT,
  major_category text NOT NULL CHECK (length(btrim(major_category)) BETWEEN 1 AND 160),
  scenarios text[] NOT NULL CHECK (cardinality(scenarios) > 0),
  regions text[] NOT NULL CHECK (cardinality(regions) > 0),
  entry_modules text[] NOT NULL DEFAULT ARRAY[]::text[],
  monitorable_content text[] NOT NULL DEFAULT ARRAY[]::text[],
  extractable_clues text[] NOT NULL DEFAULT ARRAY[]::text[],
  tracking_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
  suggested_access text[] NOT NULL DEFAULT ARRAY[]::text[],
  compliance_boundary text,
  priority text NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  coverage_status text NOT NULL DEFAULT 'unknown'
    CHECK (coverage_status IN ('unknown', 'not_covered', 'partial', 'covered')),
  delivery_status text NOT NULL DEFAULT 'exploring'
    CHECK (delivery_status IN ('exploring', 'planned', 'doing', 'blocked', 'complete', 'paused', 'retired')),
  review_status text NOT NULL DEFAULT 'needs_review'
    CHECK (review_status IN ('needs_review', 'verified', 'rejected')),
  runtime_status text NOT NULL DEFAULT 'not_configured'
    CHECK (runtime_status IN ('not_configured', 'unknown', 'healthy', 'degraded', 'failed')),
  owner text,
  connector_hints text[] NOT NULL DEFAULT ARRAY[]::text[],
  notes text,
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_refs) = 'array'),
  custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(custom_fields) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  archived_at timestamptz,
  imported_from text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (parent_source_id IS NULL OR parent_source_id <> id)
);

CREATE TABLE IF NOT EXISTS catalog.source_catalog_events (
  id uuid PRIMARY KEY,
  entry_id uuid NOT NULL REFERENCES catalog.source_catalog_entries(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  actor text NOT NULL CHECK (length(btrim(actor)) BETWEEN 1 AND 160),
  from_revision integer CHECK (from_revision IS NULL OR from_revision > 0),
  to_revision integer NOT NULL CHECK (to_revision > 0),
  changes jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(changes) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (from_revision IS NULL OR to_revision > from_revision)
);

CREATE INDEX IF NOT EXISTS source_catalog_entries_active_status_idx
  ON catalog.source_catalog_entries
    (coverage_status, delivery_status, priority, updated_at DESC)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS source_catalog_entries_category_idx
  ON catalog.source_catalog_entries (major_category, priority, legacy_sequence)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS source_catalog_entries_parent_idx
  ON catalog.source_catalog_entries (parent_source_id)
  WHERE parent_source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS source_catalog_entries_owner_idx
  ON catalog.source_catalog_entries (owner, updated_at DESC)
  WHERE owner IS NOT NULL AND archived_at IS NULL;

CREATE INDEX IF NOT EXISTS source_catalog_entries_name_idx
  ON catalog.source_catalog_entries (lower(canonical_name));

CREATE INDEX IF NOT EXISTS source_catalog_entries_aliases_idx
  ON catalog.source_catalog_entries USING gin (aliases);

CREATE INDEX IF NOT EXISTS source_catalog_entries_scenarios_idx
  ON catalog.source_catalog_entries USING gin (scenarios);

CREATE INDEX IF NOT EXISTS source_catalog_entries_regions_idx
  ON catalog.source_catalog_entries USING gin (regions);

CREATE INDEX IF NOT EXISTS source_catalog_entries_tags_idx
  ON catalog.source_catalog_entries USING gin (tags);

CREATE INDEX IF NOT EXISTS source_catalog_events_entry_idx
  ON catalog.source_catalog_events (entry_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS source_catalog_events_type_idx
  ON catalog.source_catalog_events (event_type, created_at DESC, id DESC);

CREATE TEMP TABLE source_catalog_seed_036 ON COMMIT DROP AS
SELECT *
FROM jsonb_to_recordset(
$source_catalog_seed$
[
  {
    "id": "2127ac9d-cf0f-5dd7-bfc3-c52984f9e9b5",
    "source_key": "source-catalog-0001",
    "legacy_sequence": 1,
    "canonical_name": "抖音",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "搜索",
      "话题",
      "用户主页",
      "视频",
      "评论",
      "直播切片",
      "商品锚点"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "tikhub"
    ],
    "notes": "tikhub",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=2",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=1",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=1",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=1",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "tikhub",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "2f8e99fb-0e6d-5c6f-bce3-61deec3de0ca",
    "event_changes": {
      "after": {
        "id": "2127ac9d-cf0f-5dd7-bfc3-c52984f9e9b5",
        "sourceKey": "source-catalog-0001",
        "legacySequence": 1,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "3e0370ac-9f33-56bd-b47e-10b5bc7bea4d",
    "source_key": "source-catalog-0002",
    "legacy_sequence": 2,
    "canonical_name": "快手",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "搜索",
      "话题",
      "用户主页",
      "短视频",
      "评论",
      "直播切片",
      "小店锚点"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "tikhub"
    ],
    "notes": "tikhub",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=3",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=2",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=2",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=2",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "tikhub",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "394a792a-efd2-5fbe-91d7-8f177d308359",
    "event_changes": {
      "after": {
        "id": "3e0370ac-9f33-56bd-b47e-10b5bc7bea4d",
        "sourceKey": "source-catalog-0002",
        "legacySequence": 2,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "77dcc293-e2fd-53ca-9def-56b5ab9b0729",
    "source_key": "source-catalog-0003",
    "legacy_sequence": 3,
    "canonical_name": "微信视频号",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "视频号",
      "搜一搜",
      "话题",
      "评论",
      "直播",
      "视频号小店"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "tikhub"
    ],
    "notes": "tikhub",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=4",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=3",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=3",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=3",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "tikhub",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "5ad3ae57-a16c-5c3e-ac19-677c39540e59",
    "event_changes": {
      "after": {
        "id": "77dcc293-e2fd-53ca-9def-56b5ab9b0729",
        "sourceKey": "source-catalog-0003",
        "legacySequence": 3,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "491c69be-b20e-5677-a824-85bcebc9562a",
    "source_key": "source-catalog-0004",
    "legacy_sequence": 4,
    "canonical_name": "小红书",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "笔记",
      "评论",
      "用户主页",
      "商品页",
      "品牌/企业号",
      "搜索结果"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "tikhub"
    ],
    "notes": "tikhub",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=5",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=4",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=4",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=4",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "tikhub",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "df922e05-2386-5b8e-9248-c4a11bf8ffb8",
    "event_changes": {
      "after": {
        "id": "491c69be-b20e-5677-a824-85bcebc9562a",
        "sourceKey": "source-catalog-0004",
        "legacySequence": 4,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "4753ce48-d74c-57a1-8363-56e13cddbcc7",
    "source_key": "source-catalog-0005",
    "legacy_sequence": 5,
    "canonical_name": "微博",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "微博正文",
      "评论",
      "转发",
      "超话",
      "热搜",
      "用户主页"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "tikhub"
    ],
    "notes": "tikhub",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=6",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=5",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=5",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=5",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "tikhub",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "4bdca4cf-b053-5015-95f7-01258621efde",
    "event_changes": {
      "after": {
        "id": "4753ce48-d74c-57a1-8363-56e13cddbcc7",
        "sourceKey": "source-catalog-0005",
        "legacySequence": 5,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "12b12c4a-0ac1-5b17-9bd4-8584859ff69e",
    "source_key": "source-catalog-0006",
    "legacy_sequence": 6,
    "canonical_name": "B站",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "视频",
      "动态",
      "评论",
      "弹幕",
      "专栏",
      "UP主页",
      "直播"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "tikhub"
    ],
    "notes": "tikhub",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=7",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=6",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=6",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=6",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "tikhub",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "20da2504-7d70-5dd6-b5b2-95ecf6a6580a",
    "event_changes": {
      "after": {
        "id": "12b12c4a-0ac1-5b17-9bd4-8584859ff69e",
        "sourceKey": "source-catalog-0006",
        "legacySequence": 6,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "6d1ca648-3c3b-5c1b-a603-0b74ebccdeff",
    "source_key": "source-catalog-0007",
    "legacy_sequence": 7,
    "canonical_name": "知乎",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "问题",
      "回答",
      "文章",
      "想法",
      "评论",
      "用户主页"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "tikhub"
    ],
    "notes": "tikhub",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=8",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=7",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=7",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=7",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "tikhub",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "06342a45-ef0c-5bd5-9c6f-4f2657742f49",
    "event_changes": {
      "after": {
        "id": "6d1ca648-3c3b-5c1b-a603-0b74ebccdeff",
        "sourceKey": "source-catalog-0007",
        "legacySequence": 7,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "10caf0ea-e0c5-58d0-8785-22ad1d143d56",
    "source_key": "source-catalog-0008",
    "legacy_sequence": 8,
    "canonical_name": "百度贴吧",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "吧内帖子",
      "楼层",
      "用户",
      "搜索结果"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=9",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=8",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=1",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "2536b710-6a79-5018-b216-ba266800ba12",
    "event_changes": {
      "after": {
        "id": "10caf0ea-e0c5-58d0-8785-22ad1d143d56",
        "sourceKey": "source-catalog-0008",
        "legacySequence": 8,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "e18559bf-800c-5b76-9858-b7c8dfeeae75",
    "source_key": "source-catalog-0009",
    "legacy_sequence": 9,
    "canonical_name": "豆瓣",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "小组",
      "条目短评",
      "日记",
      "广播",
      "话题"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=10",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=9",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=2",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "43cca525-8c63-5ad1-9865-bf2b1fec8dd3",
    "event_changes": {
      "after": {
        "id": "e18559bf-800c-5b76-9858-b7c8dfeeae75",
        "sourceKey": "source-catalog-0009",
        "legacySequence": 9,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "31a62fd0-39db-5da0-8f70-355bd71774f1",
    "source_key": "source-catalog-0010",
    "legacy_sequence": 10,
    "canonical_name": "今日头条",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "文章",
      "微头条",
      "视频",
      "评论",
      "账号主页"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=11",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=10",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=3",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "a259cdf1-2b92-5a6e-9188-8684263588af",
    "event_changes": {
      "after": {
        "id": "31a62fd0-39db-5da0-8f70-355bd71774f1",
        "sourceKey": "source-catalog-0010",
        "legacySequence": 10,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "f5d4feed-f982-5044-b48d-8406bf013b09",
    "source_key": "source-catalog-0011",
    "legacy_sequence": 11,
    "canonical_name": "西瓜视频",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "视频",
      "评论",
      "账号主页"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=12",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=11",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=4",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "4763112c-5d3d-51df-8c9a-95416753a12b",
    "event_changes": {
      "after": {
        "id": "f5d4feed-f982-5044-b48d-8406bf013b09",
        "sourceKey": "source-catalog-0011",
        "legacySequence": 11,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "2ccfa9a6-df17-58ca-83fe-728ab43fccbb",
    "source_key": "source-catalog-0012",
    "legacy_sequence": 12,
    "canonical_name": "好看视频",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "视频",
      "评论",
      "账号主页"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=13",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=12",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=5",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "378213d2-e62e-50e3-aa27-ad80bfb68a6d",
    "event_changes": {
      "after": {
        "id": "2ccfa9a6-df17-58ca-83fe-728ab43fccbb",
        "sourceKey": "source-catalog-0012",
        "legacySequence": 12,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "7a96776e-04f5-566d-8708-3ed85b22ff88",
    "source_key": "source-catalog-0013",
    "legacy_sequence": 13,
    "canonical_name": "百家号",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "文章",
      "作者主页",
      "评论",
      "搜索结果"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=14",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=13",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=6",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "e494ec98-9275-5d7e-a095-81f74cad0d87",
    "event_changes": {
      "after": {
        "id": "7a96776e-04f5-566d-8708-3ed85b22ff88",
        "sourceKey": "source-catalog-0013",
        "legacySequence": 13,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "3061eac1-5758-553e-a683-7c56f580e09c",
    "source_key": "source-catalog-0014",
    "legacy_sequence": 14,
    "canonical_name": "搜狐号",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "文章",
      "作者主页",
      "评论",
      "搜索结果"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=15",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=14",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=7",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "2db07d78-adf6-535d-afc1-c2a5adb62723",
    "event_changes": {
      "after": {
        "id": "3061eac1-5758-553e-a683-7c56f580e09c",
        "sourceKey": "source-catalog-0014",
        "legacySequence": 14,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "8221c7c5-9799-5d46-8bfe-cc873506ca71",
    "source_key": "source-catalog-0015",
    "legacy_sequence": 15,
    "canonical_name": "网易号",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "文章",
      "作者主页",
      "评论",
      "搜索结果"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=16",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=15",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=8",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "a90ed75b-3309-5ef4-b3f6-359e52667c17",
    "event_changes": {
      "after": {
        "id": "8221c7c5-9799-5d46-8bfe-cc873506ca71",
        "sourceKey": "source-catalog-0015",
        "legacySequence": 15,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "fd21f999-aab7-5c38-8209-804f2bb016d3",
    "source_key": "source-catalog-0016",
    "legacy_sequence": 16,
    "canonical_name": "企鹅号",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "文章",
      "作者主页",
      "腾讯内容分发入口"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=17",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=16",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=9",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "e5258cd5-4701-5e2e-9cbb-1899e12ef444",
    "event_changes": {
      "after": {
        "id": "fd21f999-aab7-5c38-8209-804f2bb016d3",
        "sourceKey": "source-catalog-0016",
        "legacySequence": 16,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "60760438-a346-5b3b-8467-9df1b070e504",
    "source_key": "source-catalog-0017",
    "legacy_sequence": 17,
    "canonical_name": "大鱼号/UC",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "文章",
      "作者主页",
      "UC信息流入口"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=18",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=17",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=10",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "776f52b9-4cc0-54a9-b950-2c8549030e1f",
    "event_changes": {
      "after": {
        "id": "60760438-a346-5b3b-8467-9df1b070e504",
        "sourceKey": "source-catalog-0017",
        "legacySequence": 17,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "c450cfde-241e-52fb-b295-f9011c11e6f3",
    "source_key": "source-catalog-0018",
    "legacy_sequence": 18,
    "canonical_name": "一点资讯",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "文章",
      "账号",
      "评论",
      "搜索结果"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=19",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=18",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=11",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "6bb6884f-443a-59e5-9eaf-047da211bed7",
    "event_changes": {
      "after": {
        "id": "c450cfde-241e-52fb-b295-f9011c11e6f3",
        "sourceKey": "source-catalog-0018",
        "legacySequence": 18,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "8d92ba35-8b54-5ca6-a49b-48c8cfec8a13",
    "source_key": "source-catalog-0019",
    "legacy_sequence": 19,
    "canonical_name": "凤凰号/凤凰新闻",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "文章",
      "作者",
      "新闻评论"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=20",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=19",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=12",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "0b838dfb-351c-5067-baea-e724f97d7128",
    "event_changes": {
      "after": {
        "id": "8d92ba35-8b54-5ca6-a49b-48c8cfec8a13",
        "sourceKey": "source-catalog-0019",
        "legacySequence": 19,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "94d36773-8912-5b8e-a593-8d0dcdaac8a3",
    "source_key": "source-catalog-0020",
    "legacy_sequence": 20,
    "canonical_name": "腾讯新闻",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "新闻",
      "评论",
      "账号主页"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=21",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=20",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=13",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "c1baf7ee-3c41-58f4-96b0-ba928566b7fa",
    "event_changes": {
      "after": {
        "id": "94d36773-8912-5b8e-a593-8d0dcdaac8a3",
        "sourceKey": "source-catalog-0020",
        "legacySequence": 20,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "a7178e7f-22b8-5465-a258-1363f4289e85",
    "source_key": "source-catalog-0021",
    "legacy_sequence": 21,
    "canonical_name": "网易新闻",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "新闻",
      "评论",
      "账号主页"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=22",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=21",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=14",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "9450861b-336b-55a5-93f2-66b31c5bbdb0",
    "event_changes": {
      "after": {
        "id": "a7178e7f-22b8-5465-a258-1363f4289e85",
        "sourceKey": "source-catalog-0021",
        "legacySequence": 21,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "26a27c11-e5ec-5087-8c62-fe42dc0590f8",
    "source_key": "source-catalog-0022",
    "legacy_sequence": 22,
    "canonical_name": "新浪新闻",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "新闻",
      "评论",
      "账号主页"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=23",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=22",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=15",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "43e58c25-aa59-582b-971f-99a4c7445bf4",
    "event_changes": {
      "after": {
        "id": "26a27c11-e5ec-5087-8c62-fe42dc0590f8",
        "sourceKey": "source-catalog-0022",
        "legacySequence": 22,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "d033ae93-91a1-5c6e-91e6-a14d0c54dd8b",
    "source_key": "source-catalog-0023",
    "legacy_sequence": 23,
    "canonical_name": "澎湃新闻",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "新闻",
      "评论",
      "号主页"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=24",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=23",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=16",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "f41d3549-a8bf-51d0-a19b-43712cc5aa18",
    "event_changes": {
      "after": {
        "id": "d033ae93-91a1-5c6e-91e6-a14d0c54dd8b",
        "sourceKey": "source-catalog-0023",
        "legacySequence": 23,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "84f652f4-44fe-5e01-8209-0b19bd337866",
    "source_key": "source-catalog-0024",
    "legacy_sequence": 24,
    "canonical_name": "观察者网",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "新闻",
      "评论",
      "号主页"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=25",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=24",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=17",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "4d89ddd0-7e7b-582d-be00-90f9c5445ebc",
    "event_changes": {
      "after": {
        "id": "84f652f4-44fe-5e01-8209-0b19bd337866",
        "sourceKey": "source-catalog-0024",
        "legacySequence": 24,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "c42f1821-b900-5a98-a936-c5286837698c",
    "source_key": "source-catalog-0025",
    "legacy_sequence": 25,
    "canonical_name": "微信公众号",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "文章",
      "历史消息",
      "评论精选",
      "账号主体信息"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=26",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=25",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=18",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "c8902b52-00c4-54da-8666-7a0bd95ee697",
    "event_changes": {
      "after": {
        "id": "c42f1821-b900-5a98-a936-c5286837698c",
        "sourceKey": "source-catalog-0025",
        "legacySequence": 25,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "f80e3465-bc17-5130-a60b-6dee342efa58",
    "source_key": "source-catalog-0026",
    "legacy_sequence": 26,
    "canonical_name": "微信搜一搜",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内社媒与内容平台",
    "scenarios": [
      "内容/舆情/评论监测"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "公众号文章",
      "视频号",
      "小程序",
      "网页结果"
    ],
    "monitorable_content": [
      "标题",
      "正文",
      "视频",
      "封面",
      "评论",
      "转发",
      "话题",
      "热榜",
      "账号主页"
    ],
    "extractable_clues": [
      "链接",
      "账号昵称",
      "账号ID",
      "发布时间",
      "互动量",
      "命中词",
      "截图",
      "商品锚点"
    ],
    "tracking_fields": [
      "账号认证",
      "企业号主体",
      "店铺/商品锚点",
      "平台可披露实名主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户授权账号",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=27",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=26",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=19",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "64c38807-5cf0-5777-9d1b-99e443bc1265",
    "event_changes": {
      "after": {
        "id": "f80e3465-bc17-5130-a60b-6dee342efa58",
        "sourceKey": "source-catalog-0026",
        "legacySequence": 26,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "965a616e-c25b-5799-92aa-c87db97e7e3c",
    "source_key": "source-catalog-0027",
    "legacy_sequence": 27,
    "canonical_name": "虎扑",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "体育/娱乐/社区讨论"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "帖子",
      "回帖",
      "用户主页",
      "话题"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=28",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=27",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=20",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "96cd8d6f-5018-5611-9d4b-3f17876425c6",
    "event_changes": {
      "after": {
        "id": "965a616e-c25b-5799-92aa-c87db97e7e3c",
        "sourceKey": "source-catalog-0027",
        "legacySequence": 27,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "7216318f-2d7a-5272-bff9-8aab9800ba25",
    "source_key": "source-catalog-0028",
    "legacy_sequence": 28,
    "canonical_name": "雪球",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "财经/投资社区"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "讨论",
      "评论",
      "用户",
      "股票话题"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=29",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=28",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=21",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "8601e42b-7036-5237-9d84-7b4e08f95b51",
    "event_changes": {
      "after": {
        "id": "7216318f-2d7a-5272-bff9-8aab9800ba25",
        "sourceKey": "source-catalog-0028",
        "legacySequence": 28,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "0ffed0f1-e1cc-50ca-b982-c5382da5aa90",
    "source_key": "source-catalog-0029",
    "legacy_sequence": 29,
    "canonical_name": "东方财富股吧",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "财经/股吧"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "帖子",
      "评论",
      "股吧",
      "用户主页"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=30",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=29",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=22",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "ba315946-7b88-5bb1-b2ac-98bf0278c916",
    "event_changes": {
      "after": {
        "id": "0ffed0f1-e1cc-50ca-b982-c5382da5aa90",
        "sourceKey": "source-catalog-0029",
        "legacySequence": 29,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "65b11894-51ba-5185-baf0-a9f05833b69b",
    "source_key": "source-catalog-0030",
    "legacy_sequence": 30,
    "canonical_name": "同花顺社区",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "财经/股民社区"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "帖子",
      "评论",
      "个股讨论"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=31",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=30",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=23",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "0a0675fa-43cc-5233-9c70-e53a72b7fcb1",
    "event_changes": {
      "after": {
        "id": "65b11894-51ba-5185-baf0-a9f05833b69b",
        "sourceKey": "source-catalog-0030",
        "legacySequence": 30,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "34e4ee83-1e8e-55d8-a295-45c5764a91fe",
    "source_key": "source-catalog-0031",
    "legacy_sequence": 31,
    "canonical_name": "脉脉",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "职场社区"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "动态",
      "评论",
      "公司页",
      "匿名区线索"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=32",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=31",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=24",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "c850a8f9-86e1-5082-b74e-6a0e4dc5684d",
    "event_changes": {
      "after": {
        "id": "34e4ee83-1e8e-55d8-a295-45c5764a91fe",
        "sourceKey": "source-catalog-0031",
        "legacySequence": 31,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "ead51765-b2d1-5590-892b-30172bd140f1",
    "source_key": "source-catalog-0032",
    "legacy_sequence": 32,
    "canonical_name": "看准网",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "职场/雇主评价"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "公司评价",
      "面经",
      "薪资",
      "评论"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=33",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=32",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=25",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "7699a842-61bf-5dfe-8e13-85460a1672ac",
    "event_changes": {
      "after": {
        "id": "ead51765-b2d1-5590-892b-30172bd140f1",
        "sourceKey": "source-catalog-0032",
        "legacySequence": 32,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "ab2072c3-27cc-5579-8494-1b4162aba905",
    "source_key": "source-catalog-0033",
    "legacy_sequence": 33,
    "canonical_name": "BOSS直聘",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "招聘/公司主页"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "公司主页",
      "职位",
      "评价线索"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=34",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=33",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=26",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "014f32f9-2704-5c70-a941-aa32375f3b5f",
    "event_changes": {
      "after": {
        "id": "ab2072c3-27cc-5579-8494-1b4162aba905",
        "sourceKey": "source-catalog-0033",
        "legacySequence": 33,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "c2322be4-16e6-5962-81d8-8762d9ea9df9",
    "source_key": "source-catalog-0034",
    "legacy_sequence": 34,
    "canonical_name": "职友集",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "招聘/公司口碑"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "公司页",
      "评价",
      "招聘信息"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=35",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=34",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=27",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "9fa206a5-f4be-5441-84df-2cfc1ad9e42c",
    "event_changes": {
      "after": {
        "id": "c2322be4-16e6-5962-81d8-8762d9ea9df9",
        "sourceKey": "source-catalog-0034",
        "legacySequence": 34,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "23f899f0-cba8-5c00-b39d-45adf51624a1",
    "source_key": "source-catalog-0035",
    "legacy_sequence": 35,
    "canonical_name": "懂车帝",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "汽车社区"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "车友圈",
      "文章",
      "视频",
      "评论"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=36",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=35",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=28",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "af64fb34-b102-5a6d-a343-ae580a2289fd",
    "event_changes": {
      "after": {
        "id": "23f899f0-cba8-5c00-b39d-45adf51624a1",
        "sourceKey": "source-catalog-0035",
        "legacySequence": 35,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "f7b51ac5-ef7f-56ce-8a20-e3b0dda9d4b7",
    "source_key": "source-catalog-0036",
    "legacy_sequence": 36,
    "canonical_name": "汽车之家",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "汽车社区"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "论坛",
      "口碑",
      "文章",
      "视频",
      "评论"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=37",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=36",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=29",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "100ffce4-f481-563c-afb0-ef3365c95b68",
    "event_changes": {
      "after": {
        "id": "f7b51ac5-ef7f-56ce-8a20-e3b0dda9d4b7",
        "sourceKey": "source-catalog-0036",
        "legacySequence": 36,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "278d13ad-06ff-5192-9ecf-d237f54ad90f",
    "source_key": "source-catalog-0037",
    "legacy_sequence": 37,
    "canonical_name": "易车",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "汽车社区"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "文章",
      "视频",
      "论坛",
      "评论"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=38",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=37",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=30",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "380b7ce6-c473-58d4-aee2-dd941f9dd26f",
    "event_changes": {
      "after": {
        "id": "278d13ad-06ff-5192-9ecf-d237f54ad90f",
        "sourceKey": "source-catalog-0037",
        "legacySequence": 37,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "7c0cf40b-20a2-552a-aae4-36a3ac1ba26d",
    "source_key": "source-catalog-0038",
    "legacy_sequence": 38,
    "canonical_name": "车质网",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "汽车投诉"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "投诉",
      "品牌/车型问题",
      "评论"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=39",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=38",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=31",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "2e44b9de-4ccb-53d8-92d2-cfeea93a2b42",
    "event_changes": {
      "after": {
        "id": "7c0cf40b-20a2-552a-aae4-36a3ac1ba26d",
        "sourceKey": "source-catalog-0038",
        "legacySequence": 38,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "9dfc3f9c-9c90-5c57-b1ef-96ae24dc178c",
    "source_key": "source-catalog-0039",
    "legacy_sequence": 39,
    "canonical_name": "什么值得买",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "消费决策社区"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "文章",
      "好价",
      "评论",
      "商品链接"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=40",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=39",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=32",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "19091d92-e990-5899-92e9-b30de4ae8ca8",
    "event_changes": {
      "after": {
        "id": "9dfc3f9c-9c90-5c57-b1ef-96ae24dc178c",
        "sourceKey": "source-catalog-0039",
        "legacySequence": 39,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "94a13ab0-9721-5e22-a99c-a535070d1434",
    "source_key": "source-catalog-0040",
    "legacy_sequence": 40,
    "canonical_name": "得物社区",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "潮流消费社区"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "社区内容",
      "评论",
      "商品页"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=41",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=40",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=33",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "0bb20e60-ddb2-5d29-bfee-4b3eab7c8a41",
    "event_changes": {
      "after": {
        "id": "94a13ab0-9721-5e22-a99c-a535070d1434",
        "sourceKey": "source-catalog-0040",
        "legacySequence": 40,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "e3df12b7-8ce9-5181-be84-0f38e0e3e212",
    "source_key": "source-catalog-0041",
    "legacy_sequence": 41,
    "canonical_name": "NGA",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "游戏/综合论坛"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "帖子",
      "回帖",
      "板块",
      "用户"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=42",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=41",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=34",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "846e9752-ee0d-58e2-894c-93279763715b",
    "event_changes": {
      "after": {
        "id": "e3df12b7-8ce9-5181-be84-0f38e0e3e212",
        "sourceKey": "source-catalog-0041",
        "legacySequence": 41,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "a33ea968-6e86-5e30-81e5-9f2d64ecbc70",
    "source_key": "source-catalog-0042",
    "legacy_sequence": 42,
    "canonical_name": "TapTap",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "游戏社区"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "游戏评价",
      "帖子",
      "评论",
      "开发者页"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=43",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=42",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=35",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "75cc270c-4189-5588-9008-205ae38dbb0d",
    "event_changes": {
      "after": {
        "id": "a33ea968-6e86-5e30-81e5-9f2d64ecbc70",
        "sourceKey": "source-catalog-0042",
        "legacySequence": 42,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "c991316e-7577-5089-9c82-3773c5480536",
    "source_key": "source-catalog-0043",
    "legacy_sequence": 43,
    "canonical_name": "17173",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "游戏媒体/论坛"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "新闻",
      "论坛",
      "评论"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=44",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=43",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=36",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "cbaf2831-7842-5323-99e9-75cf5fa9051f",
    "event_changes": {
      "after": {
        "id": "c991316e-7577-5089-9c82-3773c5480536",
        "sourceKey": "source-catalog-0043",
        "legacySequence": 43,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "b3e9cc09-39dc-57d9-80b8-832cd6cf5f75",
    "source_key": "source-catalog-0044",
    "legacy_sequence": 44,
    "canonical_name": "游民星空",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "游戏媒体/社区"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "新闻",
      "评论",
      "论坛"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=45",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=44",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=37",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "70c234fa-d2b4-530c-ae81-6661b2e682cc",
    "event_changes": {
      "after": {
        "id": "b3e9cc09-39dc-57d9-80b8-832cd6cf5f75",
        "sourceKey": "source-catalog-0044",
        "legacySequence": 44,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "5493881d-585a-5b90-ad7f-a10dfe8472d7",
    "source_key": "source-catalog-0045",
    "legacy_sequence": 45,
    "canonical_name": "小宇宙",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "播客"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "节目",
      "单集",
      "评论",
      "主播主页"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=46",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=45",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=38",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "7bdc9030-08f2-5f3f-b15d-105324f46af3",
    "event_changes": {
      "after": {
        "id": "5493881d-585a-5b90-ad7f-a10dfe8472d7",
        "sourceKey": "source-catalog-0045",
        "legacySequence": 45,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "a75bbb92-f9fb-5954-9276-d8d8a6adbc55",
    "source_key": "source-catalog-0046",
    "legacy_sequence": 46,
    "canonical_name": "喜马拉雅",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "音频平台"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "节目",
      "音频",
      "评论",
      "主播主页"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=47",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=46",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=39",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "8678aea8-4c7c-58d7-88d0-aef4a0ce5691",
    "event_changes": {
      "after": {
        "id": "a75bbb92-f9fb-5954-9276-d8d8a6adbc55",
        "sourceKey": "source-catalog-0046",
        "legacySequence": 46,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "c00f4e5d-5903-5c93-ae11-c303b3aef3f6",
    "source_key": "source-catalog-0047",
    "legacy_sequence": 47,
    "canonical_name": "荔枝FM",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "音频平台"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "节目",
      "音频",
      "评论",
      "主播主页"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=48",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=47",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=40",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "58b7d280-4c0c-532d-927f-ddcd6ab7b0fb",
    "event_changes": {
      "after": {
        "id": "c00f4e5d-5903-5c93-ae11-c303b3aef3f6",
        "sourceKey": "source-catalog-0047",
        "legacySequence": 47,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "46a879dc-2393-586a-b6d6-352738ac66e7",
    "source_key": "source-catalog-0048",
    "legacy_sequence": 48,
    "canonical_name": "蜻蜓FM",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "音频平台"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "节目",
      "音频",
      "评论",
      "主播主页"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=49",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=48",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=41",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "48f4d345-6205-5f1e-aaec-a200f4e4a236",
    "event_changes": {
      "after": {
        "id": "46a879dc-2393-586a-b6d6-352738ac66e7",
        "sourceKey": "source-catalog-0048",
        "legacySequence": 48,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "f1ba9308-6c7d-59d0-93ff-b341964ec819",
    "source_key": "source-catalog-0049",
    "legacy_sequence": 49,
    "canonical_name": "猫眼",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "影视娱乐"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "影片/演出评论",
      "用户短评",
      "艺人页"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=50",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=49",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=42",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "bd406331-54f4-5b63-8549-1778d4e109d0",
    "event_changes": {
      "after": {
        "id": "f1ba9308-6c7d-59d0-93ff-b341964ec819",
        "sourceKey": "source-catalog-0049",
        "legacySequence": 49,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "dc96a832-6ba4-51a6-bec0-2c888daa6cc8",
    "source_key": "source-catalog-0050",
    "legacy_sequence": 50,
    "canonical_name": "淘票票",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "影视娱乐"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "影片评论",
      "演出信息",
      "短评"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=51",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=50",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=43",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "4095858f-2d94-5aec-895a-a5c461e6524b",
    "event_changes": {
      "after": {
        "id": "dc96a832-6ba4-51a6-bec0-2c888daa6cc8",
        "sourceKey": "source-catalog-0050",
        "legacySequence": 50,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "17d1dc06-b838-52bf-a330-726661275bee",
    "source_key": "source-catalog-0051",
    "legacy_sequence": 51,
    "canonical_name": "宝宝树",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "母婴社区"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "帖子",
      "问答",
      "评论",
      "用户主页"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=52",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=51",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=44",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "245b582c-eb07-5873-a16d-677a2d4946ef",
    "event_changes": {
      "after": {
        "id": "17d1dc06-b838-52bf-a330-726661275bee",
        "sourceKey": "source-catalog-0051",
        "legacySequence": 51,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "1927fc8c-9092-5980-af63-9e1adb0135a7",
    "source_key": "source-catalog-0052",
    "legacy_sequence": 52,
    "canonical_name": "妈妈网",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "母婴社区"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "帖子",
      "问答",
      "评论",
      "用户主页"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=53",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=52",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=45",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "3e10e308-42af-56ca-8dc6-8c8c9b2596e4",
    "event_changes": {
      "after": {
        "id": "1927fc8c-9092-5980-af63-9e1adb0135a7",
        "sourceKey": "source-catalog-0052",
        "legacySequence": 52,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "d18fe368-33a2-5f64-a17b-e230cf1b7b6d",
    "source_key": "source-catalog-0053",
    "legacy_sequence": 53,
    "canonical_name": "美柚",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "女性/健康社区"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "帖子",
      "话题",
      "评论"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=54",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=53",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=46",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "862a214d-fc7c-5e6a-93dc-6ec727b4ebc0",
    "event_changes": {
      "after": {
        "id": "d18fe368-33a2-5f64-a17b-e230cf1b7b6d",
        "sourceKey": "source-catalog-0053",
        "legacySequence": 53,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "f3ea7a49-591e-52e6-aee2-2c715e81a14c",
    "source_key": "source-catalog-0054",
    "legacy_sequence": 54,
    "canonical_name": "丁香园",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "医疗健康社区"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "帖子",
      "文章",
      "评论",
      "机构页"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=55",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=54",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=47",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "1f70e4af-575e-542e-b8b6-0c802da4cc81",
    "event_changes": {
      "after": {
        "id": "f3ea7a49-591e-52e6-aee2-2c715e81a14c",
        "sourceKey": "source-catalog-0054",
        "legacySequence": 54,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "8ccad0d7-2b6c-5569-be43-819b3e3e0ba7",
    "source_key": "source-catalog-0055",
    "legacy_sequence": 55,
    "canonical_name": "丁香医生",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "医疗健康内容"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "文章",
      "问答",
      "评论",
      "账号主页"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=56",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=55",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=48",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "2f679967-acd5-57bf-90fa-b404a8aa50e9",
    "event_changes": {
      "after": {
        "id": "8ccad0d7-2b6c-5569-be43-819b3e3e0ba7",
        "sourceKey": "source-catalog-0055",
        "legacySequence": 55,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "16da09f7-eae1-52c7-949e-c4a929bb5283",
    "source_key": "source-catalog-0056",
    "legacy_sequence": 56,
    "canonical_name": "好大夫在线",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "医疗健康口碑"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "医生/医院评价",
      "问答",
      "文章"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=57",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=56",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=49",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "0b73a9fe-2d14-5e2b-9ec9-17cb7e4f6de6",
    "event_changes": {
      "after": {
        "id": "16da09f7-eae1-52c7-949e-c4a929bb5283",
        "sourceKey": "source-catalog-0056",
        "legacySequence": 56,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "510e0882-d946-5608-827d-daf7feb383ba",
    "source_key": "source-catalog-0057",
    "legacy_sequence": 57,
    "canonical_name": "春雨医生",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内垂直社区与论坛",
    "scenarios": [
      "医疗问答"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "问答",
      "文章",
      "医生主页"
    ],
    "monitorable_content": [
      "帖子",
      "文章",
      "评论",
      "评价",
      "问答",
      "用户主页",
      "话题"
    ],
    "extractable_clues": [
      "链接",
      "账号/作者",
      "发布时间",
      "互动量",
      "关键词",
      "截图",
      "外链"
    ],
    "tracking_fields": [
      "账号认证",
      "机构页",
      "品牌页",
      "外链店铺",
      "平台可披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "专题关键词巡检",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=58",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=57",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=50",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "092a0eb6-1a18-5485-b04e-6d8c641fc499",
    "event_changes": {
      "after": {
        "id": "510e0882-d946-5608-827d-daf7feb383ba",
        "sourceKey": "source-catalog-0057",
        "legacySequence": 57,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "5a4e3453-86f2-5980-9d07-35df7a1acd83",
    "source_key": "source-catalog-0058",
    "legacy_sequence": 58,
    "canonical_name": "淘宝",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "综合电商"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "搜索结果",
      "商品页",
      "店铺页",
      "评价",
      "问大家",
      "直播入口"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "justone"
    ],
    "notes": "justone",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=59",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=58",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=8",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=8",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "justone",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "0261c4fc-47ab-5ac5-a7ba-93dc0b9883a7",
    "event_changes": {
      "after": {
        "id": "5a4e3453-86f2-5980-9d07-35df7a1acd83",
        "sourceKey": "source-catalog-0058",
        "legacySequence": 58,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "3964d3e4-ca42-55a4-9ace-c2eebd66e488",
    "source_key": "source-catalog-0059",
    "legacy_sequence": 59,
    "canonical_name": "天猫",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "品牌/综合电商"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "搜索结果",
      "商品页",
      "旗舰店",
      "评价",
      "资质页"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "justone"
    ],
    "notes": "justone",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=60",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=59",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=9",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=9",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "justone",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "76498537-5f74-553b-af0f-0e34edf354cd",
    "event_changes": {
      "after": {
        "id": "3964d3e4-ca42-55a4-9ace-c2eebd66e488",
        "sourceKey": "source-catalog-0059",
        "legacySequence": 59,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "8057bdc8-cc03-5783-a6dd-08e44bfabe9a",
    "source_key": "source-catalog-0060",
    "legacy_sequence": 60,
    "canonical_name": "京东",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "综合电商"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "搜索结果",
      "商品页",
      "店铺页",
      "评价",
      "问答",
      "资质信息"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "justone"
    ],
    "notes": "justone",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=61",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=60",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=10",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=10",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "justone",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "63ac2424-5e44-5233-b9d1-b01ff48e6df1",
    "event_changes": {
      "after": {
        "id": "8057bdc8-cc03-5783-a6dd-08e44bfabe9a",
        "sourceKey": "source-catalog-0060",
        "legacySequence": 60,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "4e4485b3-b331-5161-841f-0e4f8db3b738",
    "source_key": "source-catalog-0061",
    "legacy_sequence": 61,
    "canonical_name": "拼多多",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "综合电商"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "搜索结果",
      "商品页",
      "店铺页",
      "评价",
      "店铺资质"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "apify",
      "device"
    ],
    "notes": "apify，真机",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=62",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=61",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=11",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=11",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "apify，真机",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "2066ebf7-fdbd-5eef-bd7c-a0ae1be568c3",
    "event_changes": {
      "after": {
        "id": "4e4485b3-b331-5161-841f-0e4f8db3b738",
        "sourceKey": "source-catalog-0061",
        "legacySequence": 61,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "f9272169-838e-5cab-a1c5-1353a446cb6d",
    "source_key": "source-catalog-0062",
    "legacy_sequence": 62,
    "canonical_name": "抖音电商",
    "aliases": [
      "抖音小店"
    ],
    "source_kind": "platform_module",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "内容电商"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "商品橱窗",
      "小店页",
      "商品锚点",
      "直播商品"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "justone"
    ],
    "notes": "justone",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=63",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=62",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=12",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=12",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "justone",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null,
        "nameConflict": {
          "canonicalName": "抖音电商",
          "detailAlias": "抖音小店"
        }
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "3909f1f4-7ee9-55f3-b79a-a0a9af692775",
    "event_changes": {
      "after": {
        "id": "f9272169-838e-5cab-a1c5-1353a446cb6d",
        "sourceKey": "source-catalog-0062",
        "legacySequence": 62,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "ad537bbb-4eb0-5297-bcae-bd9d7a533d77",
    "source_key": "source-catalog-0063",
    "legacy_sequence": 63,
    "canonical_name": "快手小店",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "内容电商"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "商品橱窗",
      "小店页",
      "商品锚点",
      "直播商品"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "justone"
    ],
    "notes": "justone",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=64",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=63",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=13",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=13",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "justone",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "bb535070-e79a-5356-9a0a-81d01a0d7728",
    "event_changes": {
      "after": {
        "id": "ad537bbb-4eb0-5297-bcae-bd9d7a533d77",
        "sourceKey": "source-catalog-0063",
        "legacySequence": 63,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "995613cb-9881-5d76-921a-1af73734a81d",
    "source_key": "source-catalog-0064",
    "legacy_sequence": 64,
    "canonical_name": "小红书店铺",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "内容电商"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "商品页",
      "店铺页",
      "笔记商品锚点",
      "评价"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "justone",
      "device"
    ],
    "notes": "真机,justone",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=65",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=64",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=14",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=14",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "真机,justone",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "474c3d2d-fdd7-5e20-8da4-63b69a38866a",
    "event_changes": {
      "after": {
        "id": "995613cb-9881-5d76-921a-1af73734a81d",
        "sourceKey": "source-catalog-0064",
        "legacySequence": 64,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "3ac0b950-3462-5fef-bd31-d18e5c877bc1",
    "source_key": "source-catalog-0065",
    "legacy_sequence": 65,
    "canonical_name": "视频号小店",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "内容电商"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "商品页",
      "店铺页",
      "直播商品",
      "视频锚点"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=66",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=65",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=51",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "1a70d75e-35fe-5eed-bc94-f0b89b1d24ad",
    "event_changes": {
      "after": {
        "id": "3ac0b950-3462-5fef-bd31-d18e5c877bc1",
        "sourceKey": "source-catalog-0065",
        "legacySequence": 65,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "5cab6db3-57ca-5ef6-8d4e-278a11a9068e",
    "source_key": "source-catalog-0066",
    "legacy_sequence": 66,
    "canonical_name": "微店",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "私域/小店"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "店铺页",
      "商品页",
      "订单/售后线索"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=67",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=66",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=52",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "1830f6e3-f787-57bf-91c1-3fdfb1befd79",
    "event_changes": {
      "after": {
        "id": "5cab6db3-57ca-5ef6-8d4e-278a11a9068e",
        "sourceKey": "source-catalog-0066",
        "legacySequence": 66,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "145e1e39-a632-547b-974a-53a6c2ffc8ac",
    "source_key": "source-catalog-0067",
    "legacy_sequence": 67,
    "canonical_name": "有赞",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "私域/小店SaaS"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "店铺页",
      "商品页",
      "商家信息",
      "交易入口"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=68",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=67",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=53",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "ca4d5e0c-23b7-5e99-87a6-99afa457316d",
    "event_changes": {
      "after": {
        "id": "145e1e39-a632-547b-974a-53a6c2ffc8ac",
        "sourceKey": "source-catalog-0067",
        "legacySequence": 67,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "55f12611-7b83-5fb4-9f64-ce9aad8bafa6",
    "source_key": "source-catalog-0068",
    "legacy_sequence": 68,
    "canonical_name": "小鹅通",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "知识付费/私域交易"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "课程页",
      "店铺页",
      "商品页",
      "主体信息"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=69",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=68",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=54",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "996e95c2-1e94-5bc4-a3ab-c84fecee67a3",
    "event_changes": {
      "after": {
        "id": "55f12611-7b83-5fb4-9f64-ce9aad8bafa6",
        "sourceKey": "source-catalog-0068",
        "legacySequence": 68,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "5094a3b4-6c36-5d67-81ed-a645df18baf7",
    "source_key": "source-catalog-0069",
    "legacy_sequence": 69,
    "canonical_name": "1688",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "B2B电商"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "公司店铺",
      "商品页",
      "供应商档案"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=70",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=69",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=55",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "6a421feb-0db2-53cd-96b9-520cab1a03ec",
    "event_changes": {
      "after": {
        "id": "5094a3b4-6c36-5d67-81ed-a645df18baf7",
        "sourceKey": "source-catalog-0069",
        "legacySequence": 69,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "717c59e8-2547-59f6-a0c2-e65ce06ed180",
    "source_key": "source-catalog-0070",
    "legacy_sequence": 70,
    "canonical_name": "京喜",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "下沉电商"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "商品页",
      "店铺页",
      "评价"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=71",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=70",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=56",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "aa9c434a-e81f-5fdd-b1b9-b5cca7256ecb",
    "event_changes": {
      "after": {
        "id": "717c59e8-2547-59f6-a0c2-e65ce06ed180",
        "sourceKey": "source-catalog-0070",
        "legacySequence": 70,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "12e50458-e3ab-5ddd-b6b8-1703c899c3d3",
    "source_key": "source-catalog-0071",
    "legacy_sequence": 71,
    "canonical_name": "唯品会",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "特卖电商"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "商品页",
      "品牌页",
      "评价"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=72",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=71",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=57",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "6196de91-b6a1-5fe8-87e6-a588cc4ab4b2",
    "event_changes": {
      "after": {
        "id": "12e50458-e3ab-5ddd-b6b8-1703c899c3d3",
        "sourceKey": "source-catalog-0071",
        "legacySequence": 71,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "118a4e18-0386-57eb-842e-35a5b51eb3e2",
    "source_key": "source-catalog-0072",
    "legacy_sequence": 72,
    "canonical_name": "苏宁易购",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "综合电商"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "商品页",
      "店铺页",
      "评价"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=73",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=72",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=58",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "a125ffa4-47be-5000-84aa-438c4c4c2f5c",
    "event_changes": {
      "after": {
        "id": "118a4e18-0386-57eb-842e-35a5b51eb3e2",
        "sourceKey": "source-catalog-0072",
        "legacySequence": 72,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "4f7ca4e1-9d06-528e-9632-de4b7dcd8174",
    "source_key": "source-catalog-0073",
    "legacy_sequence": 73,
    "canonical_name": "闲鱼",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "二手交易"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "商品",
      "卖家主页",
      "评价",
      "聊天需授权"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "justone",
      "rapid"
    ],
    "notes": "rapid/justone",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=74",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=73",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=15",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=15",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "rapid/justone",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "72fb24e3-4146-55d7-9ea5-4efa948d1bbf",
    "event_changes": {
      "after": {
        "id": "4f7ca4e1-9d06-528e-9632-de4b7dcd8174",
        "sourceKey": "source-catalog-0073",
        "legacySequence": 73,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "e306cf6f-45fc-55af-b2ab-0fbfb852a97a",
    "source_key": "source-catalog-0074",
    "legacy_sequence": 74,
    "canonical_name": "转转",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "二手交易"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "商品",
      "卖家主页",
      "评价",
      "回收/店铺入口"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=75",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=74",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=59",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "0ab3f522-7ec1-551a-a79d-44acdff45483",
    "event_changes": {
      "after": {
        "id": "e306cf6f-45fc-55af-b2ab-0fbfb852a97a",
        "sourceKey": "source-catalog-0074",
        "legacySequence": 74,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "7fa33d61-553e-5be4-a7b7-03171d1157bf",
    "source_key": "source-catalog-0075",
    "legacy_sequence": 75,
    "canonical_name": "得物",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "潮流交易"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "商品页",
      "鉴别/社区",
      "卖家/品牌线索"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=76",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=75",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=60",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "98e70742-942e-5397-98b1-1ab13253db71",
    "event_changes": {
      "after": {
        "id": "7fa33d61-553e-5be4-a7b7-03171d1157bf",
        "sourceKey": "source-catalog-0075",
        "legacySequence": 75,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "099a0acb-5446-5eee-b224-7b6f5a4280ed",
    "source_key": "source-catalog-0076",
    "legacy_sequence": 76,
    "canonical_name": "孔夫子旧书网",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "垂直电商"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "商品页",
      "店铺页",
      "卖家信息",
      "评价"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=77",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=76",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=61",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "b730aa83-5881-5b26-b69c-0f9ae223d748",
    "event_changes": {
      "after": {
        "id": "099a0acb-5446-5eee-b224-7b6f5a4280ed",
        "sourceKey": "source-catalog-0076",
        "legacySequence": 76,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "d55db7f8-6732-534e-8aa2-ae118e3ca624",
    "source_key": "source-catalog-0077",
    "legacy_sequence": 77,
    "canonical_name": "美团",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "本地生活"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "商家页",
      "评价",
      "团购",
      "搜索结果"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=78",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=77",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=62",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "2e622600-d2df-5f2b-b7d3-5251cf03540b",
    "event_changes": {
      "after": {
        "id": "d55db7f8-6732-534e-8aa2-ae118e3ca624",
        "sourceKey": "source-catalog-0077",
        "legacySequence": 77,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "6e3ebba7-2926-5abe-8bca-41d1d916d9c6",
    "source_key": "source-catalog-0078",
    "legacy_sequence": 78,
    "canonical_name": "大众点评",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "本地生活口碑"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "商家页",
      "评价",
      "榜单",
      "搜索结果"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=79",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=78",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=63",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "c1f633c2-e4be-5365-b9a6-77e77694bf8b",
    "event_changes": {
      "after": {
        "id": "6e3ebba7-2926-5abe-8bca-41d1d916d9c6",
        "sourceKey": "source-catalog-0078",
        "legacySequence": 78,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "5002d310-3102-59b8-804b-ff5c9f1c6720",
    "source_key": "source-catalog-0079",
    "legacy_sequence": 79,
    "canonical_name": "饿了么",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "本地生活/外卖"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "店铺页",
      "商品",
      "评价",
      "主体线索"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=80",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=79",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=64",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "74a1d098-dda4-5a1c-b88d-6289167548e3",
    "event_changes": {
      "after": {
        "id": "5002d310-3102-59b8-804b-ff5c9f1c6720",
        "sourceKey": "source-catalog-0079",
        "legacySequence": 79,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "064a43ba-0e0e-5bd1-b074-3071c473862d",
    "source_key": "source-catalog-0080",
    "legacy_sequence": 80,
    "canonical_name": "携程",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "旅游/酒店/票务"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "酒店/景点/评价",
      "商家页",
      "榜单"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=81",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=80",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=65",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "57367be8-cc7f-5fa6-a331-75a31f7a3e28",
    "event_changes": {
      "after": {
        "id": "064a43ba-0e0e-5bd1-b074-3071c473862d",
        "sourceKey": "source-catalog-0080",
        "legacySequence": 80,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "feb96648-45d8-5ec2-8226-9715cbefb558",
    "source_key": "source-catalog-0081",
    "legacy_sequence": 81,
    "canonical_name": "飞猪",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "旅游/票务"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "商品页",
      "店铺页",
      "评价",
      "商家主体"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=82",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=81",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=66",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "26bec515-3d1b-5f53-82d2-36075bd1f3c1",
    "event_changes": {
      "after": {
        "id": "feb96648-45d8-5ec2-8226-9715cbefb558",
        "sourceKey": "source-catalog-0081",
        "legacySequence": 81,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "07b3e6dd-f012-5051-8b0c-d26ece0c526e",
    "source_key": "source-catalog-0082",
    "legacy_sequence": 82,
    "canonical_name": "同程旅行",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "旅游/票务"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "商家页",
      "评价",
      "商品页"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=83",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=82",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=67",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "c05829e1-d7d1-5556-aa94-04145dde6ead",
    "event_changes": {
      "after": {
        "id": "07b3e6dd-f012-5051-8b0c-d26ece0c526e",
        "sourceKey": "source-catalog-0082",
        "legacySequence": 82,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "0653d9c4-6811-5125-9050-f79de3633748",
    "source_key": "source-catalog-0083",
    "legacy_sequence": 83,
    "canonical_name": "去哪儿",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "旅游/票务"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "酒店/机票/评价",
      "商家页"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=84",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=83",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=68",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "75d99363-ef1c-54d6-b608-fe621e6ab9e3",
    "event_changes": {
      "after": {
        "id": "0653d9c4-6811-5125-9050-f79de3633748",
        "sourceKey": "source-catalog-0083",
        "legacySequence": 83,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "e14a9270-e4a5-5896-8476-85d5c61c86c1",
    "source_key": "source-catalog-0084",
    "legacy_sequence": 84,
    "canonical_name": "马蜂窝",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "国内电商与本地生活",
    "scenarios": [
      "旅游社区/攻略"
    ],
    "regions": [
      "中国大陆"
    ],
    "entry_modules": [
      "攻略",
      "游记",
      "评论",
      "商家页"
    ],
    "monitorable_content": [
      "商品标题",
      "主图",
      "详情页",
      "价格",
      "销量",
      "评价",
      "店铺页",
      "资质页",
      "直播/内容锚点"
    ],
    "extractable_clues": [
      "商品ID",
      "店铺名",
      "店铺ID",
      "价格",
      "销量",
      "评价",
      "图片素材",
      "商品链接",
      "客服/售后线索"
    ],
    "tracking_fields": [
      "店铺主体",
      "营业执照",
      "品牌/生产/经销主体",
      "发票/售后主体",
      "平台可披露经营者"
    ],
    "suggested_access": [
      "公开页面监测",
      "站内搜索",
      "客户截图/订单授权",
      "平台投诉/律师函取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=85",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=84",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=69",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "ed0b2f7c-df06-5599-8c1a-48c95be69781",
    "event_changes": {
      "after": {
        "id": "e14a9270-e4a5-5896-8476-85d5c61c86c1",
        "sourceKey": "source-catalog-0084",
        "legacySequence": 84,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "2060565d-6563-58b2-b505-47167f045c2e",
    "source_key": "source-catalog-0085",
    "legacy_sequence": 85,
    "canonical_name": "TikTok",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "海外短视频"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "搜索",
      "账号主页",
      "视频",
      "评论",
      "话题",
      "TikTok Shop锚点"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=86",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=85",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=70",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "dab91717-751b-512f-b010-5e33cd55d156",
    "event_changes": {
      "after": {
        "id": "2060565d-6563-58b2-b505-47167f045c2e",
        "sourceKey": "source-catalog-0085",
        "legacySequence": 85,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "6d387552-48dc-56ec-8704-666476a457ae",
    "source_key": "source-catalog-0086",
    "legacy_sequence": 86,
    "canonical_name": "X / Twitter",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "海外社交"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "帖子",
      "评论",
      "转发",
      "账号主页",
      "话题"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "rapid"
    ],
    "notes": "rapid",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=87",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=86",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=16",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=16",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": "rapid",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "774d5f4a-d1a4-58bb-b88d-580f8a0f05cf",
    "event_changes": {
      "after": {
        "id": "6d387552-48dc-56ec-8704-666476a457ae",
        "sourceKey": "source-catalog-0086",
        "legacySequence": 86,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "80224dae-5d55-5451-a583-ef979b0c165f",
    "source_key": "source-catalog-0087",
    "legacy_sequence": 87,
    "canonical_name": "Instagram",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "海外图文/短视频"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "帖子",
      "Reels",
      "Stories需授权",
      "评论",
      "账号主页",
      "话题"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "tikhub"
    ],
    "notes": "tikhub",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=88",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=87",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=17",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=17",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": "tikhub",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "13367510-0bc1-55d4-8891-178084416dc5",
    "event_changes": {
      "after": {
        "id": "80224dae-5d55-5451-a583-ef979b0c165f",
        "sourceKey": "source-catalog-0087",
        "legacySequence": 87,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "609f94ed-c567-588a-b4e9-744b9cc8d693",
    "source_key": "source-catalog-0088",
    "legacy_sequence": 88,
    "canonical_name": "Facebook",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "海外社交"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "公开主页",
      "帖子",
      "评论",
      "群组公开内容",
      "Marketplace"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "rapid"
    ],
    "notes": "rapid",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=89",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=88",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=18",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=18",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": "rapid",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "49263bb8-7a1d-5485-a6ad-c94125b95f6c",
    "event_changes": {
      "after": {
        "id": "609f94ed-c567-588a-b4e9-744b9cc8d693",
        "sourceKey": "source-catalog-0088",
        "legacySequence": 88,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "4fc4adfb-f62a-537e-a573-1eaf6c2433a4",
    "source_key": "source-catalog-0089",
    "legacy_sequence": 89,
    "canonical_name": "YouTube",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "海外视频"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "视频",
      "Shorts",
      "频道",
      "评论",
      "直播回放"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "tikhub"
    ],
    "notes": "tikhub",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=90",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=89",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=19",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=19",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": "tikhub",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "8f028c82-f3c1-5734-8aeb-239a5f413338",
    "event_changes": {
      "after": {
        "id": "4fc4adfb-f62a-537e-a573-1eaf6c2433a4",
        "sourceKey": "source-catalog-0089",
        "legacySequence": 89,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "1200e1ac-1d24-5d87-bb8c-f604ca69534d",
    "source_key": "source-catalog-0090",
    "legacy_sequence": 90,
    "canonical_name": "Reddit",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "海外社区"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "Subreddit",
      "帖子",
      "评论",
      "用户主页"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "tikhub"
    ],
    "notes": "tikhub",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=91",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=90",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=20",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=20",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": "tikhub",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "419fce06-3945-5703-b80e-82919130b033",
    "event_changes": {
      "after": {
        "id": "1200e1ac-1d24-5d87-bb8c-f604ca69534d",
        "sourceKey": "source-catalog-0090",
        "legacySequence": 90,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "2d9d1d4a-febf-529d-807a-10b1bca5af73",
    "source_key": "source-catalog-0091",
    "legacy_sequence": 91,
    "canonical_name": "LinkedIn",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "职场社交"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "公司页",
      "个人主页",
      "帖子",
      "评论"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=92",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=91",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=71",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "2c3242cf-79b6-5cdf-acf8-96cba71d829e",
    "event_changes": {
      "after": {
        "id": "2d9d1d4a-febf-529d-807a-10b1bca5af73",
        "sourceKey": "source-catalog-0091",
        "legacySequence": 91,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "df126b09-ca95-5da6-b878-9697916a13aa",
    "source_key": "source-catalog-0092",
    "legacy_sequence": 92,
    "canonical_name": "Threads",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "海外社交"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "帖子",
      "评论",
      "账号主页"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=93",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=92",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=72",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "97f4a911-ab93-5477-9e78-00cb376e3e22",
    "event_changes": {
      "after": {
        "id": "df126b09-ca95-5da6-b878-9697916a13aa",
        "sourceKey": "source-catalog-0092",
        "legacySequence": 92,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "0d7d01a2-e716-513b-bb25-e4865d9a8cec",
    "source_key": "source-catalog-0093",
    "legacy_sequence": 93,
    "canonical_name": "Twitch",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "直播/游戏"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "频道",
      "直播标题",
      "剪辑",
      "评论/聊天需授权或公开记录"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=94",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=93",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=73",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "555139c1-94fa-5bfe-b0cf-553b44c8065c",
    "event_changes": {
      "after": {
        "id": "0d7d01a2-e716-513b-bb25-e4865d9a8cec",
        "sourceKey": "source-catalog-0093",
        "legacySequence": 93,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "d20ce39b-1be4-51db-b707-a9171055bd84",
    "source_key": "source-catalog-0094",
    "legacy_sequence": 94,
    "canonical_name": "Pinterest",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "图片兴趣社区"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "Pin",
      "图板",
      "账号",
      "外链"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=95",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=94",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=74",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "d847c745-5bee-51e0-a206-be8dc0cb4363",
    "event_changes": {
      "after": {
        "id": "d20ce39b-1be4-51db-b707-a9171055bd84",
        "sourceKey": "source-catalog-0094",
        "legacySequence": 94,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "1ddf981d-2d1b-5068-9737-d651e8d5ad5c",
    "source_key": "source-catalog-0095",
    "legacy_sequence": 95,
    "canonical_name": "Quora",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "问答社区"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "问题",
      "回答",
      "评论",
      "用户主页"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=96",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=95",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=75",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "77a7c768-3370-50e6-8318-bcdc8295f1b4",
    "event_changes": {
      "after": {
        "id": "1ddf981d-2d1b-5068-9737-d651e8d5ad5c",
        "sourceKey": "source-catalog-0095",
        "legacySequence": 95,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "bd70519a-0786-5f17-acfe-22cb36ebe827",
    "source_key": "source-catalog-0096",
    "legacy_sequence": 96,
    "canonical_name": "Medium",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "博客/长文"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "文章",
      "作者",
      "出版物",
      "评论"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=97",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=96",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=76",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "09a660f4-f5b1-558a-a06d-b3b68a1f7a12",
    "event_changes": {
      "after": {
        "id": "bd70519a-0786-5f17-acfe-22cb36ebe827",
        "sourceKey": "source-catalog-0096",
        "legacySequence": 96,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "dda78291-6906-5c9a-adf6-fcf7cdd81c76",
    "source_key": "source-catalog-0097",
    "legacy_sequence": 97,
    "canonical_name": "Tumblr",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "博客/兴趣社区"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "帖子",
      "标签",
      "账号主页"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=98",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=97",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=77",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "c224d2b1-9802-531c-88d9-5f90883ed8d3",
    "event_changes": {
      "after": {
        "id": "dda78291-6906-5c9a-adf6-fcf7cdd81c76",
        "sourceKey": "source-catalog-0097",
        "legacySequence": 97,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "5f7f38eb-7d58-5af9-890c-95e043ba30ea",
    "source_key": "source-catalog-0098",
    "legacy_sequence": 98,
    "canonical_name": "Snapchat Spotlight",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "短视频/社交"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "公开Spotlight",
      "账号线索"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=99",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=98",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=78",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "5f0c975e-10e7-5cc3-945d-1382d4bb049b",
    "event_changes": {
      "after": {
        "id": "5f7f38eb-7d58-5af9-890c-95e043ba30ea",
        "sourceKey": "source-catalog-0098",
        "legacySequence": 98,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "98ffd86b-3b5b-56b9-8eb3-a636d3bcac5e",
    "source_key": "source-catalog-0099",
    "legacy_sequence": 99,
    "canonical_name": "VK",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "海外社交"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "公开主页",
      "帖子",
      "评论",
      "社群"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=100",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=99",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=79",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "ffcc742f-2cdb-5bf7-a18c-1829d25978c9",
    "event_changes": {
      "after": {
        "id": "98ffd86b-3b5b-56b9-8eb3-a636d3bcac5e",
        "sourceKey": "source-catalog-0099",
        "legacySequence": 99,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "96a410bb-a397-5f08-9c6c-d75bdb2f0b68",
    "source_key": "source-catalog-0100",
    "legacy_sequence": 100,
    "canonical_name": "Mastodon",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "去中心社交"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "公开实例",
      "帖子",
      "账号"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=101",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=100",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=80",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "7745d938-4e88-591a-8b73-b6236efdffc9",
    "event_changes": {
      "after": {
        "id": "96a410bb-a397-5f08-9c6c-d75bdb2f0b68",
        "sourceKey": "source-catalog-0100",
        "legacySequence": 100,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "47f6ee00-d499-54fe-b498-bbd3540fef09",
    "source_key": "source-catalog-0101",
    "legacy_sequence": 101,
    "canonical_name": "Dailymotion",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "海外视频"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "视频",
      "频道",
      "评论"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=102",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=101",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=81",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "33ddb030-654d-56ad-ba01-461fa026c61c",
    "event_changes": {
      "after": {
        "id": "47f6ee00-d499-54fe-b498-bbd3540fef09",
        "sourceKey": "source-catalog-0101",
        "legacySequence": 101,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "5715678c-3ec5-5c7c-b99b-cf0882eed611",
    "source_key": "source-catalog-0102",
    "legacy_sequence": 102,
    "canonical_name": "Vimeo",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "海外视频"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "视频",
      "频道",
      "作品页"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=103",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=102",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=82",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "c6afc0b9-7f08-5d70-ad45-842ccdc826b1",
    "event_changes": {
      "after": {
        "id": "5715678c-3ec5-5c7c-b99b-cf0882eed611",
        "sourceKey": "source-catalog-0102",
        "legacySequence": 102,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "8758dcf4-7ef5-5009-8e22-786de2ea0f10",
    "source_key": "source-catalog-0103",
    "legacy_sequence": 103,
    "canonical_name": "Rumble",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "海外视频"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "视频",
      "频道",
      "评论"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=104",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=103",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=83",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "cb8cf261-ae2c-55ec-911f-4f98f8eb0cdb",
    "event_changes": {
      "after": {
        "id": "8758dcf4-7ef5-5009-8e22-786de2ea0f10",
        "sourceKey": "source-catalog-0103",
        "legacySequence": 103,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "d7010c93-d9c8-5e73-84ea-d46810b7c659",
    "source_key": "source-catalog-0104",
    "legacy_sequence": 104,
    "canonical_name": "Kick",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "海外直播"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "频道",
      "直播标题",
      "剪辑"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=105",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=104",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=84",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "fdb4ffc4-65da-5f78-97f8-6d82c8c139db",
    "event_changes": {
      "after": {
        "id": "d7010c93-d9c8-5e73-84ea-d46810b7c659",
        "sourceKey": "source-catalog-0104",
        "legacySequence": 104,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "a24c374a-ea13-542b-aefc-0a9ef3ecf20d",
    "source_key": "source-catalog-0105",
    "legacy_sequence": 105,
    "canonical_name": "Substack",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "Newsletter/博客"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "文章",
      "作者主页",
      "评论"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P2",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "rapid",
      "apify",
      "self_hosted"
    ],
    "notes": "apify，rapid，自建",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=106",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=105",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=21",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=21",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": "apify，rapid，自建",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "4379f791-3aa0-50a0-a0b1-592dc623b16c",
    "event_changes": {
      "after": {
        "id": "a24c374a-ea13-542b-aefc-0a9ef3ecf20d",
        "sourceKey": "source-catalog-0105",
        "legacySequence": 105,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "417c846c-707d-58c9-8903-35defcfc0915",
    "source_key": "source-catalog-0106",
    "legacy_sequence": 106,
    "canonical_name": "Blogspot/Blogger",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "博客"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "博客文章",
      "作者",
      "评论",
      "外链"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=107",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=106",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=85",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "067dad52-1f91-5ace-948b-a34891567cb2",
    "event_changes": {
      "after": {
        "id": "417c846c-707d-58c9-8903-35defcfc0915",
        "sourceKey": "source-catalog-0106",
        "legacySequence": 106,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "b834d814-8656-53ed-be0a-bfe9a91b636a",
    "source_key": "source-catalog-0107",
    "legacy_sequence": 107,
    "canonical_name": "WordPress.com",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外社媒与内容平台",
    "scenarios": [
      "博客/站点"
    ],
    "regions": [
      "海外"
    ],
    "entry_modules": [
      "文章",
      "页面",
      "作者",
      "评论",
      "外链"
    ],
    "monitorable_content": [
      "公开帖子",
      "视频",
      "评论",
      "话题",
      "频道/主页",
      "转发/引用",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "账号名",
      "账号ID",
      "发布时间",
      "互动量",
      "话题",
      "外链",
      "截图",
      "商品/站点入口"
    ],
    "tracking_fields": [
      "账号主页",
      "认证信息",
      "外链域名",
      "店铺链接",
      "广告主/主页信息",
      "平台披露主体"
    ],
    "suggested_access": [
      "公开页面监测",
      "平台搜索",
      "公开API/第三方合规数据",
      "客户授权账号"
    ],
    "compliance_boundary": "仅处理公开可见内容或客户授权材料,遵守当地平台条款、隐私规则和跨境数据合规要求。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=108",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=107",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=86",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "a9fb1c0a-3617-5613-b62d-c6d005ef3890",
    "event_changes": {
      "after": {
        "id": "b834d814-8656-53ed-be0a-bfe9a91b636a",
        "sourceKey": "source-catalog-0107",
        "legacySequence": 107,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "d025177d-6034-5785-a19c-699a553c40df",
    "source_key": "source-catalog-0108",
    "legacy_sequence": 108,
    "canonical_name": "Amazon",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "海外综合电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "店铺页",
      "品牌旗舰店",
      "评价",
      "卖家信息"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=109",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=108",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=87",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "4fbbff13-d333-581e-9c8f-ca1cd80bf03a",
    "event_changes": {
      "after": {
        "id": "d025177d-6034-5785-a19c-699a553c40df",
        "sourceKey": "source-catalog-0108",
        "legacySequence": 108,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "5927b416-eb65-5367-a7c7-87b9f4e4645d",
    "source_key": "source-catalog-0109",
    "legacy_sequence": 109,
    "canonical_name": "eBay",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "海外综合/二手电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "卖家页",
      "评价",
      "店铺页"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=110",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=109",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=88",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "231e980e-da05-5226-ba14-f9df81cf39cc",
    "event_changes": {
      "after": {
        "id": "5927b416-eb65-5367-a7c7-87b9f4e4645d",
        "sourceKey": "source-catalog-0109",
        "legacySequence": 109,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "229e5bdf-13a6-59f8-a1af-935f4fd50ee1",
    "source_key": "source-catalog-0110",
    "legacy_sequence": 110,
    "canonical_name": "AliExpress",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "跨境电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "店铺页",
      "评价",
      "卖家信息"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=111",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=110",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=89",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "eeec83be-4e1a-5bdb-909b-82381388bc1d",
    "event_changes": {
      "after": {
        "id": "229e5bdf-13a6-59f8-a1af-935f4fd50ee1",
        "sourceKey": "source-catalog-0110",
        "legacySequence": 110,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "cad9324b-2697-598e-b21a-8bfc41ceddcf",
    "source_key": "source-catalog-0111",
    "legacy_sequence": 111,
    "canonical_name": "Temu",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "跨境电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "店铺页",
      "评价",
      "商品图"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=112",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=111",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=90",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "90c66e24-dfd6-5929-9793-995de75ba789",
    "event_changes": {
      "after": {
        "id": "cad9324b-2697-598e-b21a-8bfc41ceddcf",
        "sourceKey": "source-catalog-0111",
        "legacySequence": 111,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "f6a6c762-8711-5b5a-96ca-a8d878358ca8",
    "source_key": "source-catalog-0112",
    "legacy_sequence": 112,
    "canonical_name": "Shein",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "跨境快时尚"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "品牌/店铺",
      "评价"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=113",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=112",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=91",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "b902f3fc-f08e-5c6a-a01c-0e733bdb23d7",
    "event_changes": {
      "after": {
        "id": "f6a6c762-8711-5b5a-96ca-a8d878358ca8",
        "sourceKey": "source-catalog-0112",
        "legacySequence": 112,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "e7128415-80cf-5163-9404-e8a0458ba9e2",
    "source_key": "source-catalog-0113",
    "legacy_sequence": 113,
    "canonical_name": "Etsy",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "手工/设计电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "店铺页",
      "卖家信息",
      "评价"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=114",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=113",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=92",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "72c68fbf-4a58-525a-a77a-b1dbcb452d20",
    "event_changes": {
      "after": {
        "id": "e7128415-80cf-5163-9404-e8a0458ba9e2",
        "sourceKey": "source-catalog-0113",
        "legacySequence": 113,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "bb0f03b0-fa28-536c-a094-52a155bac5d4",
    "source_key": "source-catalog-0114",
    "legacy_sequence": 114,
    "canonical_name": "Shopee",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "东南亚电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "店铺页",
      "评价",
      "卖家信息"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=115",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=114",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=93",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "b62da4f5-f19b-55b7-aee7-aee5c1ffd1ea",
    "event_changes": {
      "after": {
        "id": "bb0f03b0-fa28-536c-a094-52a155bac5d4",
        "sourceKey": "source-catalog-0114",
        "legacySequence": 114,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "7274217a-552a-5f7b-9e9f-49c9289f4fa3",
    "source_key": "source-catalog-0115",
    "legacy_sequence": 115,
    "canonical_name": "Lazada",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "东南亚电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "店铺页",
      "评价",
      "卖家信息"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=116",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=115",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=94",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "36ce2eeb-377b-5cae-8e88-3523ea3dc2f9",
    "event_changes": {
      "after": {
        "id": "7274217a-552a-5f7b-9e9f-49c9289f4fa3",
        "sourceKey": "source-catalog-0115",
        "legacySequence": 115,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "d103572b-35c8-5154-9adf-d4fcef51a2f0",
    "source_key": "source-catalog-0116",
    "legacy_sequence": 116,
    "canonical_name": "Walmart Marketplace",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "海外电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "卖家页",
      "评价"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=117",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=116",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=95",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "12e847c8-b701-5b3d-b675-aa20ce89442d",
    "event_changes": {
      "after": {
        "id": "d103572b-35c8-5154-9adf-d4fcef51a2f0",
        "sourceKey": "source-catalog-0116",
        "legacySequence": 116,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "563c435c-b294-5553-94b0-041928e0b698",
    "source_key": "source-catalog-0117",
    "legacy_sequence": 117,
    "canonical_name": "Target Plus",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "海外电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "卖家/品牌页"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=118",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=117",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=96",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "61083381-c365-5679-9367-df9cb2e99629",
    "event_changes": {
      "after": {
        "id": "563c435c-b294-5553-94b0-041928e0b698",
        "sourceKey": "source-catalog-0117",
        "legacySequence": 117,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "61af93da-e65c-52a5-ab8a-c60f3e780a64",
    "source_key": "source-catalog-0118",
    "legacy_sequence": 118,
    "canonical_name": "Mercado Libre",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "拉美电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "卖家页",
      "评价"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=119",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=118",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=97",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "2189b1b1-c38b-56c3-b69a-b999df1f6fcc",
    "event_changes": {
      "after": {
        "id": "61af93da-e65c-52a5-ab8a-c60f3e780a64",
        "sourceKey": "source-catalog-0118",
        "legacySequence": 118,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "60b5c6f2-ba9c-5819-b0f5-89683179a8c5",
    "source_key": "source-catalog-0119",
    "legacy_sequence": 119,
    "canonical_name": "Rakuten",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "日本/海外电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "店铺页",
      "评价"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=120",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=119",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=98",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "4ee48271-6089-5653-84cc-a099daad059d",
    "event_changes": {
      "after": {
        "id": "60b5c6f2-ba9c-5819-b0f5-89683179a8c5",
        "sourceKey": "source-catalog-0119",
        "legacySequence": 119,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "c6a6ad31-e58e-5a1c-9bef-c22ac279240f",
    "source_key": "source-catalog-0120",
    "legacy_sequence": 120,
    "canonical_name": "Coupang",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "韩国电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "卖家页",
      "评价"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=121",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=120",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=99",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "c27613d9-9d48-592b-af18-8642c5a174b5",
    "event_changes": {
      "after": {
        "id": "c6a6ad31-e58e-5a1c-9bef-c22ac279240f",
        "sourceKey": "source-catalog-0120",
        "legacySequence": 120,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "b76917c7-6e26-5a83-9bac-34bd8460b59b",
    "source_key": "source-catalog-0121",
    "legacy_sequence": 121,
    "canonical_name": "Tokopedia",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "印尼电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "店铺页",
      "评价"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=122",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=121",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=100",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "c6c24ac9-4e39-5f03-bb41-2f18b050c82d",
    "event_changes": {
      "after": {
        "id": "b76917c7-6e26-5a83-9bac-34bd8460b59b",
        "sourceKey": "source-catalog-0121",
        "legacySequence": 121,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "80796065-bfc7-5a4f-a7cb-5ed7722d9b9e",
    "source_key": "source-catalog-0122",
    "legacy_sequence": 122,
    "canonical_name": "Bukalapak",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "印尼电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "店铺页",
      "评价"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=123",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=122",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=101",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "b8e033d4-38c0-56fe-a4e0-15fc60c1b46a",
    "event_changes": {
      "after": {
        "id": "80796065-bfc7-5a4f-a7cb-5ed7722d9b9e",
        "sourceKey": "source-catalog-0122",
        "legacySequence": 122,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "daf2bfd9-d22a-58f9-b6da-495c5d22fa2b",
    "source_key": "source-catalog-0123",
    "legacy_sequence": 123,
    "canonical_name": "Flipkart",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "印度电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "卖家页",
      "评价"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=124",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=123",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=102",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "00b2cab9-d44f-5c85-bacb-0a2a7d51c9da",
    "event_changes": {
      "after": {
        "id": "daf2bfd9-d22a-58f9-b6da-495c5d22fa2b",
        "sourceKey": "source-catalog-0123",
        "legacySequence": 123,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "ae56f8b0-515e-54a8-bb8a-94b9cdeab2ed",
    "source_key": "source-catalog-0124",
    "legacy_sequence": 124,
    "canonical_name": "Facebook Marketplace",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "海外本地交易"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品",
      "卖家主页",
      "地区信息"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=125",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=124",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=103",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "75b52dbb-91ae-52ec-927c-ad14a2ad9ab9",
    "event_changes": {
      "after": {
        "id": "ae56f8b0-515e-54a8-bb8a-94b9cdeab2ed",
        "sourceKey": "source-catalog-0124",
        "legacySequence": 124,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "b86c25ae-1bd1-5d0d-a6f3-8544441ecac4",
    "source_key": "source-catalog-0125",
    "legacy_sequence": 125,
    "canonical_name": "Instagram Shop",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "海外内容电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品标签",
      "店铺",
      "账号主页"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=126",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=125",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=104",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "0e933050-4415-5b5a-9971-9a1f56d9cac0",
    "event_changes": {
      "after": {
        "id": "b86c25ae-1bd1-5d0d-a6f3-8544441ecac4",
        "sourceKey": "source-catalog-0125",
        "legacySequence": 125,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "77512db8-e493-502b-ad17-0d7b6bd92db9",
    "source_key": "source-catalog-0126",
    "legacy_sequence": 126,
    "canonical_name": "TikTok Shop Global",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "海外内容电商"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品锚点",
      "店铺",
      "达人视频"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开商品/店铺/评价/资质信息,订单、结算、实名等需客户授权、平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=127",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=126",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=105",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "c855688b-195e-534f-a230-03f26c722d5b",
    "event_changes": {
      "after": {
        "id": "77512db8-e493-502b-ad17-0d7b6bd92db9",
        "sourceKey": "source-catalog-0126",
        "legacySequence": 126,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "308577c2-711e-500b-a85f-1ce2e0f417e2",
    "source_key": "source-catalog-0127",
    "legacy_sequence": 127,
    "canonical_name": "Craigslist",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "海外分类信息"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "帖子",
      "地区",
      "联系方式线索"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=128",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=127",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=106",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "14eecde2-90ed-5914-bf09-8b0e8b8af5f6",
    "event_changes": {
      "after": {
        "id": "308577c2-711e-500b-a85f-1ce2e0f417e2",
        "sourceKey": "source-catalog-0127",
        "legacySequence": 127,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "09d89e4b-1e9f-583c-b605-142aa28761f9",
    "source_key": "source-catalog-0128",
    "legacy_sequence": 128,
    "canonical_name": "Gumtree",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "海外分类信息"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "帖子",
      "地区",
      "联系方式线索"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=129",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=128",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=107",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "67599667-3846-5ad5-a2b2-5d65883a56e8",
    "event_changes": {
      "after": {
        "id": "09d89e4b-1e9f-583c-b605-142aa28761f9",
        "sourceKey": "source-catalog-0128",
        "legacySequence": 128,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "29e88140-5d60-5d72-951e-d4a0d815b07f",
    "source_key": "source-catalog-0129",
    "legacy_sequence": 129,
    "canonical_name": "Shopify 独立站",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "独立站SaaS"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "Collection",
      "品牌页",
      "联系方式",
      "政策页"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=130",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=129",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=108",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "702d56fe-7bff-52e5-9545-6cc25bacef81",
    "event_changes": {
      "after": {
        "id": "29e88140-5d60-5d72-951e-d4a0d815b07f",
        "sourceKey": "source-catalog-0129",
        "legacySequence": 129,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "7324043a-7697-5e57-b609-b8f3cc32eb65",
    "source_key": "source-catalog-0130",
    "legacy_sequence": 130,
    "canonical_name": "WooCommerce / WordPress 商城",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "独立站商城"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "文章",
      "页面",
      "联系方式",
      "支付入口"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=131",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=130",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=109",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "e2c8ce7c-6b2c-562d-ade0-0766fdbb7251",
    "event_changes": {
      "after": {
        "id": "7324043a-7697-5e57-b609-b8f3cc32eb65",
        "sourceKey": "source-catalog-0130",
        "legacySequence": 130,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "fb8c772e-cc68-5c2d-8354-80f66de3e0b8",
    "source_key": "source-catalog-0131",
    "legacy_sequence": 131,
    "canonical_name": "Magento / Adobe Commerce",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "独立站商城"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "商品页",
      "品牌页",
      "联系方式",
      "站点结构"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=132",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=131",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=110",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "c23f614c-a899-5d5a-8ab3-1a679e362807",
    "event_changes": {
      "after": {
        "id": "fb8c772e-cc68-5c2d-8354-80f66de3e0b8",
        "sourceKey": "source-catalog-0131",
        "legacySequence": 131,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "771ed3d4-bacf-5a14-8c8e-fe8affc72e59",
    "source_key": "source-catalog-0132",
    "legacy_sequence": 132,
    "canonical_name": "Wix 独立站",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "独立站SaaS"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "页面",
      "商品",
      "表单",
      "联系方式"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=133",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=132",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=111",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "f04f5efe-c398-5d96-89b2-92f98e559c84",
    "event_changes": {
      "after": {
        "id": "771ed3d4-bacf-5a14-8c8e-fe8affc72e59",
        "sourceKey": "source-catalog-0132",
        "legacySequence": 132,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "7ecefff5-ae0b-55a3-9452-b91c9cdfe009",
    "source_key": "source-catalog-0133",
    "legacy_sequence": 133,
    "canonical_name": "Squarespace 独立站",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "独立站SaaS"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "页面",
      "商品",
      "博客",
      "联系方式"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=134",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=133",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=112",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "83c129a5-c63c-5a90-916f-a9b48328f065",
    "event_changes": {
      "after": {
        "id": "7ecefff5-ae0b-55a3-9452-b91c9cdfe009",
        "sourceKey": "source-catalog-0133",
        "legacySequence": 133,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "3ccabbc8-c5b7-5322-8b22-24ee1e3b4d18",
    "source_key": "source-catalog-0134",
    "legacy_sequence": 134,
    "canonical_name": "Webflow 独立站",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "海外电商、跨境与独立站",
    "scenarios": [
      "独立站SaaS"
    ],
    "regions": [
      "海外",
      "跨境"
    ],
    "entry_modules": [
      "页面",
      "落地页",
      "表单",
      "联系方式"
    ],
    "monitorable_content": [
      "商品标题",
      "图片",
      "详情页",
      "价格",
      "评价",
      "店铺/卖家页",
      "联系方式",
      "政策页",
      "支付入口"
    ],
    "extractable_clues": [
      "URL",
      "商品ID/SKU",
      "店铺/卖家名",
      "价格",
      "评价",
      "图片素材",
      "联系方式",
      "外链",
      "截图"
    ],
    "tracking_fields": [
      "卖家主体",
      "品牌主体",
      "域名注册线索",
      "联系方式",
      "支付/售后主体",
      "平台可披露卖家资料"
    ],
    "suggested_access": [
      "公开页面监测",
      "搜索引擎发现",
      "站点巡检",
      "客户授权材料",
      "平台投诉/法务取证"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=135",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=134",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=113",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "海外/跨境",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "ac8c3ed7-53d4-5063-9bbb-4f1ee9c075b1",
    "event_changes": {
      "after": {
        "id": "3ccabbc8-c5b7-5322-8b22-24ee1e3b4d18",
        "sourceKey": "source-catalog-0134",
        "legacySequence": 134,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "cb2bc950-7929-5cf9-9498-64638a2eac45",
    "source_key": "source-catalog-0135",
    "legacy_sequence": 135,
    "canonical_name": "百度搜索",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "搜索引擎"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "网页/资讯/视频/图片/知道/贴吧结果"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=136",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=135",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=114",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "18617958-7373-580b-b0b9-2be061dbc751",
    "event_changes": {
      "after": {
        "id": "cb2bc950-7929-5cf9-9498-64638a2eac45",
        "sourceKey": "source-catalog-0135",
        "legacySequence": 135,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "bf6e4dee-ae2a-5ae6-bf78-51359856a2ad",
    "source_key": "source-catalog-0136",
    "legacy_sequence": 136,
    "canonical_name": "Google Search",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "搜索引擎"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "网页/新闻/图片/视频/购物结果"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=137",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=136",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=115",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "8d6c442a-7013-55d1-99e3-ec6f8625cfde",
    "event_changes": {
      "after": {
        "id": "bf6e4dee-ae2a-5ae6-bf78-51359856a2ad",
        "sourceKey": "source-catalog-0136",
        "legacySequence": 136,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "c71b13cc-6617-58a4-8c9c-3912aa296545",
    "source_key": "source-catalog-0137",
    "legacy_sequence": 137,
    "canonical_name": "Bing",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "搜索引擎"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "网页/新闻/图片/视频结果"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P1",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "self_hosted"
    ],
    "notes": "自建",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=138",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=137",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=22",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=22",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "自建",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "60ca893f-f89a-5a39-8ebf-f4a115553442",
    "event_changes": {
      "after": {
        "id": "c71b13cc-6617-58a4-8c9c-3912aa296545",
        "sourceKey": "source-catalog-0137",
        "legacySequence": 137,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "78d294fa-d698-515d-b704-cdf45629ec75",
    "source_key": "source-catalog-0138",
    "legacy_sequence": 138,
    "canonical_name": "搜狗搜索",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "搜索引擎"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "网页/微信/知乎等结果"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=139",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=138",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=116",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "66850062-c250-543d-8cba-5d7657690fd2",
    "event_changes": {
      "after": {
        "id": "78d294fa-d698-515d-b704-cdf45629ec75",
        "sourceKey": "source-catalog-0138",
        "legacySequence": 138,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "144bc1cb-e387-5ad0-95ec-0fe612392728",
    "source_key": "source-catalog-0139",
    "legacy_sequence": 139,
    "canonical_name": "360搜索",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "搜索引擎"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "网页/新闻/视频结果"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=140",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=139",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=117",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "8d16d69a-31b6-5cd2-8677-f4a56c7c33c1",
    "event_changes": {
      "after": {
        "id": "144bc1cb-e387-5ad0-95ec-0fe612392728",
        "sourceKey": "source-catalog-0139",
        "legacySequence": 139,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "14094fd1-21e3-5f09-9ea4-d14a630ff511",
    "source_key": "source-catalog-0140",
    "legacy_sequence": 140,
    "canonical_name": "百度指数",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "趋势/热度"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "关键词趋势",
      "人群画像",
      "地域热度"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=141",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=140",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=118",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "f7f1ee6d-0ae8-539f-8ee5-7e1a681ced89",
    "event_changes": {
      "after": {
        "id": "14094fd1-21e3-5f09-9ea4-d14a630ff511",
        "sourceKey": "source-catalog-0140",
        "legacySequence": 140,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "6556a528-740f-5a79-9c37-e74ed1e9bbf9",
    "source_key": "source-catalog-0141",
    "legacy_sequence": 141,
    "canonical_name": "Google Trends",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "海外趋势"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "关键词趋势",
      "地域",
      "相关查询"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=142",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=141",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=119",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "0c893568-d043-55f9-a8a1-c48c00ba2c96",
    "event_changes": {
      "after": {
        "id": "6556a528-740f-5a79-9c37-e74ed1e9bbf9",
        "sourceKey": "source-catalog-0141",
        "legacySequence": 141,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "c068784f-1a01-5e5d-a74d-0237cdc81c4e",
    "source_key": "source-catalog-0142",
    "legacy_sequence": 142,
    "canonical_name": "微博热搜/话题榜",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "热榜"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "热搜",
      "话题",
      "榜单变化"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "tikhub"
    ],
    "notes": "tikhub",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=143",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=142",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=23",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=23",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "tikhub",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "af69f579-4ae1-505d-9ce1-9c2c7e2d6c88",
    "event_changes": {
      "after": {
        "id": "c068784f-1a01-5e5d-a74d-0237cdc81c4e",
        "sourceKey": "source-catalog-0142",
        "legacySequence": 142,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "3d0fb679-6266-5c40-96d3-21293e2f4802",
    "source_key": "source-catalog-0143",
    "legacy_sequence": 143,
    "canonical_name": "抖音热点榜",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "热榜"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "热点",
      "视频",
      "话题",
      "作者"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=144",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=143",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=120",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "7af722a4-7546-5a77-a4e8-b0abadc79820",
    "event_changes": {
      "after": {
        "id": "3d0fb679-6266-5c40-96d3-21293e2f4802",
        "sourceKey": "source-catalog-0143",
        "legacySequence": 143,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "a3b2ee19-e6da-555e-aa25-21c5cf9e4adf",
    "source_key": "source-catalog-0144",
    "legacy_sequence": 144,
    "canonical_name": "小红书搜索建议/热词",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "热词/搜索"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "关键词",
      "联想词",
      "笔记结果"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=145",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=144",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=121",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "89a9c4e2-3c68-5dbd-96d8-21c788c7a71a",
    "event_changes": {
      "after": {
        "id": "a3b2ee19-e6da-555e-aa25-21c5cf9e4adf",
        "sourceKey": "source-catalog-0144",
        "legacySequence": 144,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "870b7b90-00f9-5513-bd41-bc405b5698f7",
    "source_key": "source-catalog-0145",
    "legacy_sequence": 145,
    "canonical_name": "B站排行榜/热榜",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "热榜"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "分区热榜",
      "视频",
      "UP主"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=146",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=145",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=122",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "8c8df263-2c90-5514-be37-2e2123a11cbd",
    "event_changes": {
      "after": {
        "id": "870b7b90-00f9-5513-bd41-bc405b5698f7",
        "sourceKey": "source-catalog-0145",
        "legacySequence": 145,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "8e919c81-4e03-5099-9277-17858e6c925d",
    "source_key": "source-catalog-0146",
    "legacy_sequence": 146,
    "canonical_name": "百度新闻",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "新闻聚合"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "新闻",
      "来源",
      "转载链路"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=147",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=146",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=123",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "947bcd5c-9c14-5c4e-b975-8ff022dfa256",
    "event_changes": {
      "after": {
        "id": "8e919c81-4e03-5099-9277-17858e6c925d",
        "sourceKey": "source-catalog-0146",
        "legacySequence": 146,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "054d7ffd-aabe-5f22-8a0b-50f4af473e24",
    "source_key": "source-catalog-0147",
    "legacy_sequence": 147,
    "canonical_name": "Google News",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "海外新闻聚合"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "新闻",
      "来源",
      "转载链路"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=148",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=147",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=124",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "5e4cc20e-8587-58f1-8399-d0da2848db89",
    "event_changes": {
      "after": {
        "id": "054d7ffd-aabe-5f22-8a0b-50f4af473e24",
        "sourceKey": "source-catalog-0147",
        "legacySequence": 147,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "bd8bef09-b483-5da9-8e19-0d54d5e6fcec",
    "source_key": "source-catalog-0148",
    "legacy_sequence": 148,
    "canonical_name": "今日热榜类聚合站",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "榜单聚合"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "跨平台热榜",
      "链接",
      "更新时间"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=149",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=148",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=125",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "5a44c7d9-73e4-5ae1-ba6a-e1ee8b4aed22",
    "event_changes": {
      "after": {
        "id": "bd8bef09-b483-5da9-8e19-0d54d5e6fcec",
        "sourceKey": "source-catalog-0148",
        "legacySequence": 148,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "a82ba0e6-4300-5410-804c-c2916d5189b7",
    "source_key": "source-catalog-0149",
    "legacy_sequence": 149,
    "canonical_name": "新闻网站",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "新闻/媒体"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "新闻正文",
      "评论",
      "转载",
      "作者"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "self_hosted"
    ],
    "notes": "自建",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=150",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=149",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=24",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=24",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "自建",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "adb2bb32-e800-587c-a1ed-35deeb6ad861",
    "event_changes": {
      "after": {
        "id": "a82ba0e6-4300-5410-804c-c2916d5189b7",
        "sourceKey": "source-catalog-0149",
        "legacySequence": 149,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "fe662d5c-7c21-584b-bb64-e7e8b5080058",
    "source_key": "source-catalog-0150",
    "legacy_sequence": 150,
    "canonical_name": "地方媒体网站",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "地方新闻"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "本地新闻",
      "评论",
      "转载"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=151",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=150",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=126",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "40338eac-a469-5f65-991c-796487eaa8ea",
    "event_changes": {
      "after": {
        "id": "fe662d5c-7c21-584b-bb64-e7e8b5080058",
        "sourceKey": "source-catalog-0150",
        "legacySequence": 150,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "3e483c30-d461-52c2-badf-f551bec9a86e",
    "source_key": "source-catalog-0151",
    "legacy_sequence": 151,
    "canonical_name": "行业垂直媒体",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "行业媒体"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "文章",
      "评论",
      "作者",
      "机构页"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=152",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=151",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=127",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "ace1360a-8cc2-5674-8473-9399b5fbb515",
    "event_changes": {
      "after": {
        "id": "3e483c30-d461-52c2-badf-f551bec9a86e",
        "sourceKey": "source-catalog-0151",
        "legacySequence": 151,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "2b455fd8-30d9-5d7f-bbb3-9a43cc0aad87",
    "source_key": "source-catalog-0152",
    "legacy_sequence": 152,
    "canonical_name": "论坛站点",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "开放论坛"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "帖子",
      "楼层",
      "用户",
      "外链"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=153",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=152",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=128",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "e6cc1d03-3352-51a1-a64b-59fd481e3fa8",
    "event_changes": {
      "after": {
        "id": "2b455fd8-30d9-5d7f-bbb3-9a43cc0aad87",
        "sourceKey": "source-catalog-0152",
        "legacySequence": 152,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "14fc238b-b9e5-58f3-b422-92cff0dafccd",
    "source_key": "source-catalog-0153",
    "legacy_sequence": 153,
    "canonical_name": "博客站点",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "个人/机构博客"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "文章",
      "评论",
      "作者",
      "外链"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=154",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=153",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=129",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "05c382d9-c099-5e24-9f6b-c47ad54c8b52",
    "event_changes": {
      "after": {
        "id": "14fc238b-b9e5-58f3-b422-92cff0dafccd",
        "sourceKey": "source-catalog-0153",
        "legacySequence": 153,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "f4a3acc5-fc03-5b87-acb6-629f34228562",
    "source_key": "source-catalog-0154",
    "legacy_sequence": 154,
    "canonical_name": "问答站点",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "问答/知识"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "问题",
      "回答",
      "评论",
      "作者"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=155",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=154",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=130",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "3aa93e62-5485-5014-bbc7-f83597ba3f8b",
    "event_changes": {
      "after": {
        "id": "f4a3acc5-fc03-5b87-acb6-629f34228562",
        "sourceKey": "source-catalog-0154",
        "legacySequence": 154,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "76016452-1c3a-57e0-bd44-59e4801f2f3a",
    "source_key": "source-catalog-0155",
    "legacy_sequence": 155,
    "canonical_name": "资源站/下载站",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "资源分发"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "下载页",
      "素材页",
      "联系方式",
      "外链"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=156",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=155",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=131",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "0f152967-3d5f-5631-a7e8-dc2f4b677136",
    "event_changes": {
      "after": {
        "id": "76016452-1c3a-57e0-bd44-59e4801f2f3a",
        "sourceKey": "source-catalog-0155",
        "legacySequence": 155,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "fec2fa80-9025-570a-b190-1928dc23f5df",
    "source_key": "source-catalog-0156",
    "legacy_sequence": 156,
    "canonical_name": "百科站点",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "百科/知识库"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "词条",
      "编辑记录",
      "引用来源"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=157",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=156",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=132",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "ecb62fca-a0c8-545f-910e-548359ee0965",
    "event_changes": {
      "after": {
        "id": "fec2fa80-9025-570a-b190-1928dc23f5df",
        "sourceKey": "source-catalog-0156",
        "legacySequence": 156,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "3e7e1164-eff9-585a-8f6e-610cae1b6b24",
    "source_key": "source-catalog-0157",
    "legacy_sequence": 157,
    "canonical_name": "网盘资源页",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "资源传播"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "分享标题",
      "链接",
      "提取码线索",
      "传播来源"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=158",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=157",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=133",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "beb1ee6e-1288-5fa4-83d6-898defa7a226",
    "event_changes": {
      "after": {
        "id": "3e7e1164-eff9-585a-8f6e-610cae1b6b24",
        "sourceKey": "source-catalog-0157",
        "legacySequence": 157,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "1fa50802-c74c-5ea4-83ca-81563db5443f",
    "source_key": "source-catalog-0158",
    "legacy_sequence": 158,
    "canonical_name": "代码仓库",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "开源/代码"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "仓库",
      "README",
      "Issue",
      "域名/密钥线索"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=159",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=158",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=134",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "229b5a79-8557-557c-9d70-a3af06d661f2",
    "event_changes": {
      "after": {
        "id": "1fa50802-c74c-5ea4-83ca-81563db5443f",
        "sourceKey": "source-catalog-0158",
        "legacySequence": 158,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "7d6216af-8b9d-526b-ae6c-2afaf7a28c3d",
    "source_key": "source-catalog-0159",
    "legacy_sequence": 159,
    "canonical_name": "学术论文/预印本",
    "aliases": [],
    "source_kind": "source_class",
    "parent_source_id": null,
    "major_category": "搜索引擎与开放网络",
    "scenarios": [
      "学术/研究"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "论文标题",
      "作者",
      "机构",
      "引用"
    ],
    "monitorable_content": [
      "搜索结果",
      "网页标题",
      "正文摘要",
      "新闻",
      "论坛",
      "博客",
      "问答",
      "热榜",
      "外链"
    ],
    "extractable_clues": [
      "URL",
      "来源站点",
      "发布时间",
      "作者",
      "摘要",
      "命中词",
      "转载关系",
      "截图"
    ],
    "tracking_fields": [
      "网站主体",
      "备案信息",
      "域名",
      "联系方式",
      "作者/机构",
      "外链店铺/账号"
    ],
    "suggested_access": [
      "公开搜索",
      "关键词巡检",
      "站点巡检",
      "搜索结果留存",
      "人工复核"
    ],
    "compliance_boundary": "仅处理公开网页、域名、备案、页面内容和客户授权材料,避免绕过访问控制。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=160",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=159",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=135",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "09b2d0a8-20e0-56d3-9897-ffc109affe84",
    "event_changes": {
      "after": {
        "id": "7d6216af-8b9d-526b-ae6c-2afaf7a28c3d",
        "sourceKey": "source-catalog-0159",
        "legacySequence": 159,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "2f703651-b73e-5067-8303-c7cbb665b09f",
    "source_key": "source-catalog-0160",
    "legacy_sequence": 160,
    "canonical_name": "Telegram 公开频道",
    "aliases": [],
    "source_kind": "platform_module",
    "parent_source_id": null,
    "major_category": "群聊与私域线索（可选）",
    "scenarios": [
      "公开频道/公开群组"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "频道消息",
      "转发",
      "链接",
      "用户名"
    ],
    "monitorable_content": [
      "群公告",
      "聊天记录",
      "转发链接",
      "截图",
      "文件",
      "频道消息",
      "传播链路"
    ],
    "extractable_clues": [
      "群名",
      "频道名",
      "账号/用户名",
      "消息时间",
      "链接",
      "截图",
      "转发来源"
    ],
    "tracking_fields": [
      "群主/管理员公开信息",
      "账号线索",
      "外链域名/店铺",
      "客户可提供成员线索"
    ],
    "suggested_access": [
      "客户授权",
      "客户提供截图/导出记录",
      "公开频道/公开群组监测",
      "人工复核"
    ],
    "compliance_boundary": "非公开群聊/私域内容仅基于客户授权、客户提供截图/导出记录或合法合规方式整理分析。",
    "priority": "P1",
    "coverage_status": "covered",
    "delivery_status": "complete",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": "如对外材料不展示群聊能力，可保留在内部数据源清单。",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=161",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=160",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=25",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=25",
        "label": "Supported-platform projection row"
      },
      {
        "type": "document",
        "key": "docs/operations/telegram-monitor-ingestion.md",
        "label": "Telegram monitor ingestion runbook"
      },
      {
        "type": "document",
        "key": "docs/operations/telegram-sqlite-api-ingestion.md",
        "label": "Telegram SQLite API ingestion runbook"
      },
      {
        "type": "pipeline",
        "key": "server/ingest/telegram/monitor-pipeline.mjs",
        "label": "Telegram monitor pipeline"
      },
      {
        "type": "pipeline",
        "key": "server/ingest/telegram/sqlite-pipeline.mjs",
        "label": "Telegram SQLite pipeline"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "如对外材料不展示群聊能力，可保留在内部数据源清单。",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": "如对外材料不展示群聊能力,可保留在内部数据源清单。"
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "d7527051-372e-564c-a7ee-9424ae049005",
    "event_changes": {
      "after": {
        "id": "2f703651-b73e-5067-8303-c7cbb665b09f",
        "sourceKey": "source-catalog-0160",
        "legacySequence": 160,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "f39b1f0f-39dd-5397-9540-2e4aef492d53",
    "source_key": "source-catalog-0161",
    "legacy_sequence": 161,
    "canonical_name": "Telegram 公开群组",
    "aliases": [],
    "source_kind": "platform_module",
    "parent_source_id": null,
    "major_category": "群聊与私域线索（可选）",
    "scenarios": [
      "公开频道/公开群组"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "群消息",
      "转发",
      "链接",
      "用户名"
    ],
    "monitorable_content": [
      "群公告",
      "聊天记录",
      "转发链接",
      "截图",
      "文件",
      "频道消息",
      "传播链路"
    ],
    "extractable_clues": [
      "群名",
      "频道名",
      "账号/用户名",
      "消息时间",
      "链接",
      "截图",
      "转发来源"
    ],
    "tracking_fields": [
      "群主/管理员公开信息",
      "账号线索",
      "外链域名/店铺",
      "客户可提供成员线索"
    ],
    "suggested_access": [
      "客户授权",
      "客户提供截图/导出记录",
      "公开频道/公开群组监测",
      "人工复核"
    ],
    "compliance_boundary": "非公开群聊/私域内容仅基于客户授权、客户提供截图/导出记录或合法合规方式整理分析。",
    "priority": "P1",
    "coverage_status": "covered",
    "delivery_status": "complete",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": "如对外材料不展示群聊能力，可保留在内部数据源清单。",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=162",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=161",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=26",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=26",
        "label": "Supported-platform projection row"
      },
      {
        "type": "document",
        "key": "docs/operations/telegram-monitor-ingestion.md",
        "label": "Telegram monitor ingestion runbook"
      },
      {
        "type": "document",
        "key": "docs/operations/telegram-sqlite-api-ingestion.md",
        "label": "Telegram SQLite API ingestion runbook"
      },
      {
        "type": "pipeline",
        "key": "server/ingest/telegram/monitor-pipeline.mjs",
        "label": "Telegram monitor pipeline"
      },
      {
        "type": "pipeline",
        "key": "server/ingest/telegram/sqlite-pipeline.mjs",
        "label": "Telegram SQLite pipeline"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "如对外材料不展示群聊能力，可保留在内部数据源清单。",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": "如对外材料不展示群聊能力,可保留在内部数据源清单。"
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "b7a0b30a-ef8a-521d-b2ec-4fd4d6f99482",
    "event_changes": {
      "after": {
        "id": "f39b1f0f-39dd-5397-9540-2e4aef492d53",
        "sourceKey": "source-catalog-0161",
        "legacySequence": 161,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "1cd654de-49b3-5f52-a45a-373bbc7abf67",
    "source_key": "source-catalog-0162",
    "legacy_sequence": 162,
    "canonical_name": "QQ群",
    "aliases": [],
    "source_kind": "platform_module",
    "parent_source_id": null,
    "major_category": "群聊与私域线索（可选）",
    "scenarios": [
      "客户授权/客户提供"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "群公告",
      "聊天截图",
      "导出记录",
      "群文件",
      "群成员线索"
    ],
    "monitorable_content": [
      "群公告",
      "聊天记录",
      "转发链接",
      "截图",
      "文件",
      "频道消息",
      "传播链路"
    ],
    "extractable_clues": [
      "群名",
      "频道名",
      "账号/用户名",
      "消息时间",
      "链接",
      "截图",
      "转发来源"
    ],
    "tracking_fields": [
      "群主/管理员公开信息",
      "账号线索",
      "外链域名/店铺",
      "客户可提供成员线索"
    ],
    "suggested_access": [
      "客户授权",
      "客户提供截图/导出记录",
      "公开频道/公开群组监测",
      "人工复核"
    ],
    "compliance_boundary": "非公开群聊/私域内容仅基于客户授权、客户提供截图/导出记录或合法合规方式整理分析。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": "如对外材料不展示群聊能力，可保留在内部数据源清单。",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=163",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=162",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=136",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "如对外材料不展示群聊能力，可保留在内部数据源清单。",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": "如对外材料不展示群聊能力,可保留在内部数据源清单。"
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "5cd637c0-6666-5e28-8c16-bc81c0dbb5cb",
    "event_changes": {
      "after": {
        "id": "1cd654de-49b3-5f52-a45a-373bbc7abf67",
        "sourceKey": "source-catalog-0162",
        "legacySequence": 162,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "0e5d775d-1269-5475-b7f1-7ba3257c670c",
    "source_key": "source-catalog-0163",
    "legacy_sequence": 163,
    "canonical_name": "微信群",
    "aliases": [],
    "source_kind": "platform_module",
    "parent_source_id": null,
    "major_category": "群聊与私域线索（可选）",
    "scenarios": [
      "客户授权/客户提供"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "聊天截图",
      "群公告",
      "转发链路",
      "群成员线索"
    ],
    "monitorable_content": [
      "群公告",
      "聊天记录",
      "转发链接",
      "截图",
      "文件",
      "频道消息",
      "传播链路"
    ],
    "extractable_clues": [
      "群名",
      "频道名",
      "账号/用户名",
      "消息时间",
      "链接",
      "截图",
      "转发来源"
    ],
    "tracking_fields": [
      "群主/管理员公开信息",
      "账号线索",
      "外链域名/店铺",
      "客户可提供成员线索"
    ],
    "suggested_access": [
      "客户授权",
      "客户提供截图/导出记录",
      "公开频道/公开群组监测",
      "人工复核"
    ],
    "compliance_boundary": "非公开群聊/私域内容仅基于客户授权、客户提供截图/导出记录或合法合规方式整理分析。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": "如对外材料不展示群聊能力，可保留在内部数据源清单。",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=164",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=163",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=137",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "如对外材料不展示群聊能力，可保留在内部数据源清单。",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": "如对外材料不展示群聊能力,可保留在内部数据源清单。"
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "fc6e35e0-200c-51f7-ba23-7b29c9490794",
    "event_changes": {
      "after": {
        "id": "0e5d775d-1269-5475-b7f1-7ba3257c670c",
        "sourceKey": "source-catalog-0163",
        "legacySequence": 163,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "03a0dbdc-cfc4-51af-b9bd-daa87851e6ef",
    "source_key": "source-catalog-0164",
    "legacy_sequence": 164,
    "canonical_name": "Discord 公开服务器/频道",
    "aliases": [],
    "source_kind": "platform_module",
    "parent_source_id": null,
    "major_category": "群聊与私域线索（可选）",
    "scenarios": [
      "公开或授权频道"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "频道消息",
      "公告",
      "链接",
      "成员公开信息"
    ],
    "monitorable_content": [
      "群公告",
      "聊天记录",
      "转发链接",
      "截图",
      "文件",
      "频道消息",
      "传播链路"
    ],
    "extractable_clues": [
      "群名",
      "频道名",
      "账号/用户名",
      "消息时间",
      "链接",
      "截图",
      "转发来源"
    ],
    "tracking_fields": [
      "群主/管理员公开信息",
      "账号线索",
      "外链域名/店铺",
      "客户可提供成员线索"
    ],
    "suggested_access": [
      "客户授权",
      "客户提供截图/导出记录",
      "公开频道/公开群组监测",
      "人工复核"
    ],
    "compliance_boundary": "非公开群聊/私域内容仅基于客户授权、客户提供截图/导出记录或合法合规方式整理分析。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": "如对外材料不展示群聊能力，可保留在内部数据源清单。",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=165",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=164",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=138",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "如对外材料不展示群聊能力，可保留在内部数据源清单。",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": "如对外材料不展示群聊能力,可保留在内部数据源清单。"
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "8ddc0ca3-7791-533a-b809-d95e0f0388f6",
    "event_changes": {
      "after": {
        "id": "03a0dbdc-cfc4-51af-b9bd-daa87851e6ef",
        "sourceKey": "source-catalog-0164",
        "legacySequence": 164,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "ca4ced50-d4b9-51f3-a5ab-eae15abc17fc",
    "source_key": "source-catalog-0165",
    "legacy_sequence": 165,
    "canonical_name": "WhatsApp 群",
    "aliases": [],
    "source_kind": "platform_module",
    "parent_source_id": null,
    "major_category": "群聊与私域线索（可选）",
    "scenarios": [
      "客户授权/客户提供"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "聊天导出",
      "截图",
      "转发链路"
    ],
    "monitorable_content": [
      "群公告",
      "聊天记录",
      "转发链接",
      "截图",
      "文件",
      "频道消息",
      "传播链路"
    ],
    "extractable_clues": [
      "群名",
      "频道名",
      "账号/用户名",
      "消息时间",
      "链接",
      "截图",
      "转发来源"
    ],
    "tracking_fields": [
      "群主/管理员公开信息",
      "账号线索",
      "外链域名/店铺",
      "客户可提供成员线索"
    ],
    "suggested_access": [
      "客户授权",
      "客户提供截图/导出记录",
      "公开频道/公开群组监测",
      "人工复核"
    ],
    "compliance_boundary": "非公开群聊/私域内容仅基于客户授权、客户提供截图/导出记录或合法合规方式整理分析。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": "如对外材料不展示群聊能力，可保留在内部数据源清单。",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=166",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=165",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=139",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "如对外材料不展示群聊能力，可保留在内部数据源清单。",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": "如对外材料不展示群聊能力,可保留在内部数据源清单。"
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "5bfbbcb7-d3f0-5843-88f6-33cf2a260083",
    "event_changes": {
      "after": {
        "id": "ca4ced50-d4b9-51f3-a5ab-eae15abc17fc",
        "sourceKey": "source-catalog-0165",
        "legacySequence": 165,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "f5d0b7a1-b123-534a-8a62-85f5aecd6a33",
    "source_key": "source-catalog-0166",
    "legacy_sequence": 166,
    "canonical_name": "Line 群/频道",
    "aliases": [],
    "source_kind": "platform_module",
    "parent_source_id": null,
    "major_category": "群聊与私域线索（可选）",
    "scenarios": [
      "客户授权/客户提供"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "聊天截图",
      "频道消息",
      "转发链路"
    ],
    "monitorable_content": [
      "群公告",
      "聊天记录",
      "转发链接",
      "截图",
      "文件",
      "频道消息",
      "传播链路"
    ],
    "extractable_clues": [
      "群名",
      "频道名",
      "账号/用户名",
      "消息时间",
      "链接",
      "截图",
      "转发来源"
    ],
    "tracking_fields": [
      "群主/管理员公开信息",
      "账号线索",
      "外链域名/店铺",
      "客户可提供成员线索"
    ],
    "suggested_access": [
      "客户授权",
      "客户提供截图/导出记录",
      "公开频道/公开群组监测",
      "人工复核"
    ],
    "compliance_boundary": "非公开群聊/私域内容仅基于客户授权、客户提供截图/导出记录或合法合规方式整理分析。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": "如对外材料不展示群聊能力，可保留在内部数据源清单。",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=167",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=166",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=140",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "如对外材料不展示群聊能力，可保留在内部数据源清单。",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": "如对外材料不展示群聊能力,可保留在内部数据源清单。"
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "49b02553-24f3-5cab-ba85-44feb1891ab1",
    "event_changes": {
      "after": {
        "id": "f5d0b7a1-b123-534a-8a62-85f5aecd6a33",
        "sourceKey": "source-catalog-0166",
        "legacySequence": 166,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "e5c8b5d6-4264-58c0-b69d-30b10bc79634",
    "source_key": "source-catalog-0167",
    "legacy_sequence": 167,
    "canonical_name": "企业微信/飞书群",
    "aliases": [],
    "source_kind": "platform_module",
    "parent_source_id": null,
    "major_category": "群聊与私域线索（可选）",
    "scenarios": [
      "客户授权/客户提供"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "聊天截图",
      "内部舆情线索",
      "处置记录"
    ],
    "monitorable_content": [
      "群公告",
      "聊天记录",
      "转发链接",
      "截图",
      "文件",
      "频道消息",
      "传播链路"
    ],
    "extractable_clues": [
      "群名",
      "频道名",
      "账号/用户名",
      "消息时间",
      "链接",
      "截图",
      "转发来源"
    ],
    "tracking_fields": [
      "群主/管理员公开信息",
      "账号线索",
      "外链域名/店铺",
      "客户可提供成员线索"
    ],
    "suggested_access": [
      "客户授权",
      "客户提供截图/导出记录",
      "公开频道/公开群组监测",
      "人工复核"
    ],
    "compliance_boundary": "非公开群聊/私域内容仅基于客户授权、客户提供截图/导出记录或合法合规方式整理分析。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": "如对外材料不展示群聊能力，可保留在内部数据源清单。",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=168",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=167",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=141",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "如对外材料不展示群聊能力，可保留在内部数据源清单。",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": "如对外材料不展示群聊能力,可保留在内部数据源清单。"
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "50e55fbb-95d0-5ea0-bb4e-36abe9687439",
    "event_changes": {
      "after": {
        "id": "e5c8b5d6-4264-58c0-b69d-30b10bc79634",
        "sourceKey": "source-catalog-0167",
        "legacySequence": 167,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "d676590f-c513-5176-9d32-2a8cd65d624f",
    "source_key": "source-catalog-0168",
    "legacy_sequence": 168,
    "canonical_name": "国家企业信用信息公示系统",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "工商主体"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "企业登记",
      "法定代表人",
      "住所",
      "经营范围",
      "年报"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=169",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=168",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=142",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "ae680fde-39cb-5d21-ac00-37430c6fe91f",
    "event_changes": {
      "after": {
        "id": "d676590f-c513-5176-9d32-2a8cd65d624f",
        "sourceKey": "source-catalog-0168",
        "legacySequence": 168,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "2a7af7ba-661f-5f74-a570-ce3b4127d353",
    "source_key": "source-catalog-0169",
    "legacy_sequence": 169,
    "canonical_name": "信用中国",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "信用/行政处罚"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "企业信用",
      "行政处罚",
      "异常名录线索"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=170",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=169",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=143",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "3f2ef96f-eeda-5688-b85a-8772b53472a6",
    "event_changes": {
      "after": {
        "id": "2a7af7ba-661f-5f74-a570-ce3b4127d353",
        "sourceKey": "source-catalog-0169",
        "legacySequence": 169,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "95a16917-e1af-54fb-9886-65fc0904ec94",
    "source_key": "source-catalog-0170",
    "legacy_sequence": 170,
    "canonical_name": "中国执行信息公开网",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "执行信息"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "被执行人",
      "失信被执行人",
      "执行标的"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=171",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=170",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=144",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "fe3ab30e-9bdc-5e41-b82b-7643315074f2",
    "event_changes": {
      "after": {
        "id": "95a16917-e1af-54fb-9886-65fc0904ec94",
        "sourceKey": "source-catalog-0170",
        "legacySequence": 170,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "361d2d72-f6d2-5690-8834-5b9a6a3548f5",
    "source_key": "source-catalog-0171",
    "legacy_sequence": 171,
    "canonical_name": "中国裁判文书网",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "司法文书"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "案件文书",
      "当事人",
      "案由",
      "法院"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=172",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=171",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=145",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "b4c481ac-9fcb-5964-a9ca-bcbd52fdb89d",
    "event_changes": {
      "after": {
        "id": "361d2d72-f6d2-5690-8834-5b9a6a3548f5",
        "sourceKey": "source-catalog-0171",
        "legacySequence": 171,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "f98a9f65-0434-5f56-8b6a-1762113f3599",
    "source_key": "source-catalog-0172",
    "legacy_sequence": 172,
    "canonical_name": "企查查",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "工商聚合"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "工商",
      "股权",
      "变更",
      "司法",
      "商标",
      "网站备案"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "official_mcp"
    ],
    "notes": "官方提供mcp接口。工商接口API - 企查查开放平台",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=173",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=172",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=27",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=27",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "官方提供mcp接口。工商接口API - 企查查开放平台",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "24e04133-c7d8-54f1-b20b-0ca6d7791285",
    "event_changes": {
      "after": {
        "id": "f98a9f65-0434-5f56-8b6a-1762113f3599",
        "sourceKey": "source-catalog-0172",
        "legacySequence": 172,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "6f4411cd-621c-5796-84b3-76c953c2fedf",
    "source_key": "source-catalog-0173",
    "legacy_sequence": 173,
    "canonical_name": "天眼查",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "工商聚合"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "工商",
      "股权",
      "风险",
      "商标",
      "网站备案"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P0",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "official_api"
    ],
    "notes": "官方提供239个接口，天眼数据 | API数据接口 | 企业数据 - 天眼查",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=174",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=173",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=28",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=28",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "官方提供239个接口，天眼数据 | API数据接口 | 企业数据 - 天眼查",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "81f2b1dc-3c75-5652-93f6-510ce880b5e8",
    "event_changes": {
      "after": {
        "id": "6f4411cd-621c-5796-84b3-76c953c2fedf",
        "sourceKey": "source-catalog-0173",
        "legacySequence": 173,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "acb52e03-088b-503e-bcd4-f027091bdb11",
    "source_key": "source-catalog-0174",
    "legacy_sequence": 174,
    "canonical_name": "爱企查",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "工商聚合"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "工商",
      "股权",
      "风险",
      "商标",
      "网站备案"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=175",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=174",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=146",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "08c61cff-8411-53a6-b5fa-047d886fddab",
    "event_changes": {
      "after": {
        "id": "acb52e03-088b-503e-bcd4-f027091bdb11",
        "sourceKey": "source-catalog-0174",
        "legacySequence": 174,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "e19c1cd2-6522-5c50-937a-7e68a051c550",
    "source_key": "source-catalog-0175",
    "legacy_sequence": 175,
    "canonical_name": "启信宝",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "工商聚合"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "工商",
      "股权",
      "风险",
      "知识产权"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "official_api"
    ],
    "notes": "官方提供接口，工商信息API接口 - 启信慧眼数据开放平台",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=176",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=175",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=147",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "官方提供接口，工商信息API接口 - 启信慧眼数据开放平台",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "44ec79bf-c068-54a9-a3a6-d76c3dfa3352",
    "event_changes": {
      "after": {
        "id": "e19c1cd2-6522-5c50-937a-7e68a051c550",
        "sourceKey": "source-catalog-0175",
        "legacySequence": 175,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "f41daea4-02e5-5a3d-96dd-c16e74fd62b0",
    "source_key": "source-catalog-0176",
    "legacy_sequence": 176,
    "canonical_name": "ICP备案查询",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "网站备案"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "主办单位",
      "备案号",
      "网站名称",
      "域名"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P0",
    "coverage_status": "not_covered",
    "delivery_status": "exploring",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=177",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=176",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=148",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "596880c6-da8d-5047-8a31-3967c02c02d1",
    "event_changes": {
      "after": {
        "id": "f41daea4-02e5-5a3d-96dd-c16e74fd62b0",
        "sourceKey": "source-catalog-0176",
        "legacySequence": 176,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "760bdc47-6f13-5ce3-bfa1-1179cd272f02",
    "source_key": "source-catalog-0177",
    "legacy_sequence": 177,
    "canonical_name": "公安联网备案",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "网站备案"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "网站主体",
      "公安备案号",
      "域名线索"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=178",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=177",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=149",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "5abb65f2-2d96-53d2-b97b-09c692d68c83",
    "event_changes": {
      "after": {
        "id": "760bdc47-6f13-5ce3-bfa1-1179cd272f02",
        "sourceKey": "source-catalog-0177",
        "legacySequence": 177,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "41c19a3c-abfc-5554-8b08-aecd9eccec86",
    "source_key": "source-catalog-0178",
    "legacy_sequence": 178,
    "canonical_name": "商标局/商标查询",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "知识产权"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "商标申请人",
      "类别",
      "状态",
      "代理机构"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=179",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=178",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=150",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "d2c49d71-199f-5c82-88ce-c6ffecf1c29e",
    "event_changes": {
      "after": {
        "id": "41c19a3c-abfc-5554-8b08-aecd9eccec86",
        "sourceKey": "source-catalog-0178",
        "legacySequence": 178,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "763e6095-54cc-57f7-a876-9d1b9b99a23f",
    "source_key": "source-catalog-0179",
    "legacy_sequence": 179,
    "canonical_name": "专利检索系统",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "知识产权"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "专利申请人",
      "发明人",
      "地址",
      "状态"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=180",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=179",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=151",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "33aa8946-12b6-5081-958e-c69edff42645",
    "event_changes": {
      "after": {
        "id": "763e6095-54cc-57f7-a876-9d1b9b99a23f",
        "sourceKey": "source-catalog-0179",
        "legacySequence": 179,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "4f8bc226-e1ec-5dc4-8f20-f9dc759edc17",
    "source_key": "source-catalog-0180",
    "legacy_sequence": 180,
    "canonical_name": "WHOIS / ICANN Lookup",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "域名注册"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "注册商",
      "注册日期",
      "DNS",
      "匿名保护线索"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=181",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=180",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=152",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "3f112d11-52ae-5509-b1c2-9547fa74369d",
    "event_changes": {
      "after": {
        "id": "4f8bc226-e1ec-5dc4-8f20-f9dc759edc17",
        "sourceKey": "source-catalog-0180",
        "legacySequence": 180,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "05e5d437-6331-5f59-a603-43ceefa4b4d1",
    "source_key": "source-catalog-0181",
    "legacy_sequence": 181,
    "canonical_name": "DNS 记录",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "域名技术线索"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "A/CNAME/MX/NS/TXT记录",
      "CDN线索"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=182",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=181",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=153",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "89be8ae0-03ee-59f2-b68b-e68d53c2c225",
    "event_changes": {
      "after": {
        "id": "05e5d437-6331-5f59-a603-43ceefa4b4d1",
        "sourceKey": "source-catalog-0181",
        "legacySequence": 181,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "3de1f586-1554-56dd-82d1-d7d4539010ae",
    "source_key": "source-catalog-0182",
    "legacy_sequence": 182,
    "canonical_name": "SSL 证书透明日志",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "证书/域名"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "证书主体",
      "SAN域名",
      "签发时间"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=183",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=182",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=154",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "4f6b7f2c-497f-5f74-a7ff-afd4cc34893d",
    "event_changes": {
      "after": {
        "id": "3de1f586-1554-56dd-82d1-d7d4539010ae",
        "sourceKey": "source-catalog-0182",
        "legacySequence": 182,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "58bf7972-5f86-54e3-a172-6dd6cebfc0e8",
    "source_key": "source-catalog-0183",
    "legacy_sequence": 183,
    "canonical_name": "Wayback Machine",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "历史网页"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "历史页面",
      "旧联系方式",
      "旧商品页"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=184",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=183",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=155",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "c3523fd0-8b49-5a7d-acb0-1d2f24b8870f",
    "event_changes": {
      "after": {
        "id": "58bf7972-5f86-54e3-a172-6dd6cebfc0e8",
        "sourceKey": "source-catalog-0183",
        "legacySequence": 183,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "a3f0f8f6-11a6-5d66-b39c-d8d2ac15dacc",
    "source_key": "source-catalog-0184",
    "legacy_sequence": 184,
    "canonical_name": "BuiltWith",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "站点技术栈"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "站点技术",
      "支付/营销插件",
      "平台类型"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=185",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=184",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=156",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "d5f13c33-4a76-5ba2-b16e-fc2f85968490",
    "event_changes": {
      "after": {
        "id": "a3f0f8f6-11a6-5d66-b39c-d8d2ac15dacc",
        "sourceKey": "source-catalog-0184",
        "legacySequence": 184,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "c80ad751-577a-544c-b6ad-d827dfed6432",
    "source_key": "source-catalog-0185",
    "legacy_sequence": 185,
    "canonical_name": "Similarweb",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "站点流量"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "流量",
      "来源",
      "地区",
      "竞品站点"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=186",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=185",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=157",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "e74ab9e2-9d06-5499-924a-0611f7313eb0",
    "event_changes": {
      "after": {
        "id": "c80ad751-577a-544c-b6ad-d827dfed6432",
        "sourceKey": "source-catalog-0185",
        "legacySequence": 185,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "788c49e1-13bc-5531-a2d2-24377e43faf9",
    "source_key": "source-catalog-0186",
    "legacy_sequence": 186,
    "canonical_name": "SecurityTrails",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "域名/IP情报"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "DNS历史",
      "子域名",
      "IP关系"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=187",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=186",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=158",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "e6d9972d-a167-57f1-837e-f7af73f0684a",
    "event_changes": {
      "after": {
        "id": "788c49e1-13bc-5531-a2d2-24377e43faf9",
        "sourceKey": "source-catalog-0186",
        "legacySequence": 186,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "ee0e3fdd-26c8-5882-bbce-12c0fe16a0bb",
    "source_key": "source-catalog-0187",
    "legacy_sequence": 187,
    "canonical_name": "Censys",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "互联网资产"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "证书",
      "主机",
      "服务",
      "IP线索"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=188",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=187",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=159",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "dc0919ae-3f45-59d5-b675-3b3f35c94aef",
    "event_changes": {
      "after": {
        "id": "ee0e3fdd-26c8-5882-bbce-12c0fe16a0bb",
        "sourceKey": "source-catalog-0187",
        "legacySequence": 187,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "c7309c39-f7ac-504b-8bb1-8c2a306bc3e3",
    "source_key": "source-catalog-0188",
    "legacy_sequence": 188,
    "canonical_name": "Shodan",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "互联网资产"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "主机",
      "端口",
      "证书",
      "地理位置"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P2",
    "coverage_status": "covered",
    "delivery_status": "doing",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [
      "vip"
    ],
    "notes": "shodan - vip",
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=189",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=188",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.fugai.txt#sha256=0ec1b959e5ca68f2bda1037e1b733bbbbe19c826afefad3ed472e5e0ce3d5b82&row=29",
        "label": "已覆盖 filtered view row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/01.support_platform.txt#sha256=9dad7653b3a3084733849b6fbce82787609b1d0102e8494686bd4702dc787f1c&row=29",
        "label": "Supported-platform projection row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "已覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": "shodan - vip",
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "057d6ce9-cab1-5c4b-a9c4-d13466a3eb34",
    "event_changes": {
      "after": {
        "id": "c7309c39-f7ac-504b-8bb1-8c2a306bc3e3",
        "sourceKey": "source-catalog-0188",
        "legacySequence": 188,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "991a5fe3-437a-5d0d-9ddd-ccd85838dcf5",
    "source_key": "source-catalog-0189",
    "legacy_sequence": 189,
    "canonical_name": "OpenCorporates",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "海外公司登记聚合"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "公司名称",
      "注册地",
      "董事/地址公开线索"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=190",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=189",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=160",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "4f86ca16-fd07-59e3-a613-36c8156d24a1",
    "event_changes": {
      "after": {
        "id": "991a5fe3-437a-5d0d-9ddd-ccd85838dcf5",
        "sourceKey": "source-catalog-0189",
        "legacySequence": 189,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "38cd7d3b-966b-5707-b996-bbcda4daac87",
    "source_key": "source-catalog-0190",
    "legacy_sequence": 190,
    "canonical_name": "SEC EDGAR",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "美国上市公司披露"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "公司披露",
      "主体",
      "管理层",
      "文件"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=191",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=190",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=161",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "8a35aefb-f619-5f48-935c-4d0d3929cc49",
    "event_changes": {
      "after": {
        "id": "38cd7d3b-966b-5707-b996-bbcda4daac87",
        "sourceKey": "source-catalog-0190",
        "legacySequence": 190,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "78a77483-b032-547a-a7d5-8514b0f8a5fd",
    "source_key": "source-catalog-0191",
    "legacy_sequence": 191,
    "canonical_name": "UK Companies House",
    "aliases": [],
    "source_kind": "registry",
    "parent_source_id": null,
    "major_category": "主体追踪与资质数据源",
    "scenarios": [
      "英国公司登记"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "公司登记",
      "董事",
      "地址",
      "文件"
    ],
    "monitorable_content": [
      "企业登记",
      "备案",
      "域名",
      "知识产权",
      "司法",
      "信用",
      "技术资产",
      "历史网页"
    ],
    "extractable_clues": [
      "企业名称",
      "统一社会信用代码/注册号",
      "法定代表人",
      "地址",
      "备案号",
      "域名",
      "联系方式"
    ],
    "tracking_fields": [
      "工商主体",
      "网站主体",
      "商标/专利权利人",
      "域名注册线索",
      "关联企业/股东/高管"
    ],
    "suggested_access": [
      "公开登记查询",
      "第三方合规数据",
      "客户授权材料",
      "人工复核"
    ],
    "compliance_boundary": "以公开登记、公开检索或客户授权材料为准,最终法律主体以官方登记和平台披露为准。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=192",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=191",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=162",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "fedeafce-851a-5843-9b7b-6d5e7ed2d06f",
    "event_changes": {
      "after": {
        "id": "78a77483-b032-547a-a7d5-8514b0f8a5fd",
        "sourceKey": "source-catalog-0191",
        "legacySequence": 191,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "86220064-f3bd-5e54-af59-d44b54970263",
    "source_key": "source-catalog-0192",
    "legacy_sequence": 192,
    "canonical_name": "Apple App Store",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "应用商店与评论",
    "scenarios": [
      "应用商店"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "应用详情",
      "开发者",
      "评分",
      "评论",
      "版本记录"
    ],
    "monitorable_content": [
      "应用名称",
      "开发者",
      "评分",
      "评论",
      "版本",
      "榜单",
      "关键词",
      "截图"
    ],
    "extractable_clues": [
      "开发者名称",
      "官网",
      "隐私政策",
      "联系方式",
      "评论风险",
      "版本时间"
    ],
    "tracking_fields": [
      "开发者主体",
      "官网域名",
      "隐私政策主体",
      "应用备案/软著线索"
    ],
    "suggested_access": [
      "公开页面监测",
      "应用商店搜索",
      "客户授权账号",
      "第三方合规数据"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=193",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=192",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=163",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "eacf2502-74db-55a4-84a3-ed35bcb38a61",
    "event_changes": {
      "after": {
        "id": "86220064-f3bd-5e54-af59-d44b54970263",
        "sourceKey": "source-catalog-0192",
        "legacySequence": 192,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "c14b4a88-d15f-5e35-b308-4fe61bc9d50b",
    "source_key": "source-catalog-0193",
    "legacy_sequence": 193,
    "canonical_name": "Google Play",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "应用商店与评论",
    "scenarios": [
      "应用商店"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "应用详情",
      "开发者",
      "评分",
      "评论",
      "版本记录"
    ],
    "monitorable_content": [
      "应用名称",
      "开发者",
      "评分",
      "评论",
      "版本",
      "榜单",
      "关键词",
      "截图"
    ],
    "extractable_clues": [
      "开发者名称",
      "官网",
      "隐私政策",
      "联系方式",
      "评论风险",
      "版本时间"
    ],
    "tracking_fields": [
      "开发者主体",
      "官网域名",
      "隐私政策主体",
      "应用备案/软著线索"
    ],
    "suggested_access": [
      "公开页面监测",
      "应用商店搜索",
      "客户授权账号",
      "第三方合规数据"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=194",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=193",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=164",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "7776c1f6-d9d9-5a01-9993-3c6f0e1708ec",
    "event_changes": {
      "after": {
        "id": "c14b4a88-d15f-5e35-b308-4fe61bc9d50b",
        "sourceKey": "source-catalog-0193",
        "legacySequence": 193,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "43c80fc5-e61f-53da-851f-9d7a5520366d",
    "source_key": "source-catalog-0194",
    "legacy_sequence": 194,
    "canonical_name": "华为应用市场",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "应用商店与评论",
    "scenarios": [
      "国内应用商店"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "应用详情",
      "开发者",
      "评分",
      "评论"
    ],
    "monitorable_content": [
      "应用名称",
      "开发者",
      "评分",
      "评论",
      "版本",
      "榜单",
      "关键词",
      "截图"
    ],
    "extractable_clues": [
      "开发者名称",
      "官网",
      "隐私政策",
      "联系方式",
      "评论风险",
      "版本时间"
    ],
    "tracking_fields": [
      "开发者主体",
      "官网域名",
      "隐私政策主体",
      "应用备案/软著线索"
    ],
    "suggested_access": [
      "公开页面监测",
      "应用商店搜索",
      "客户授权账号",
      "第三方合规数据"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=195",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=194",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=165",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "1a969fb6-0599-55a6-9d84-2e130bdfe224",
    "event_changes": {
      "after": {
        "id": "43c80fc5-e61f-53da-851f-9d7a5520366d",
        "sourceKey": "source-catalog-0194",
        "legacySequence": 194,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "2d5108f8-27f4-5fa5-9906-ffdb17439394",
    "source_key": "source-catalog-0195",
    "legacy_sequence": 195,
    "canonical_name": "小米应用商店",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "应用商店与评论",
    "scenarios": [
      "国内应用商店"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "应用详情",
      "开发者",
      "评分",
      "评论"
    ],
    "monitorable_content": [
      "应用名称",
      "开发者",
      "评分",
      "评论",
      "版本",
      "榜单",
      "关键词",
      "截图"
    ],
    "extractable_clues": [
      "开发者名称",
      "官网",
      "隐私政策",
      "联系方式",
      "评论风险",
      "版本时间"
    ],
    "tracking_fields": [
      "开发者主体",
      "官网域名",
      "隐私政策主体",
      "应用备案/软著线索"
    ],
    "suggested_access": [
      "公开页面监测",
      "应用商店搜索",
      "客户授权账号",
      "第三方合规数据"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=196",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=195",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=166",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "5470b29d-dac1-5119-b8e5-1943b3a8eb90",
    "event_changes": {
      "after": {
        "id": "2d5108f8-27f4-5fa5-9906-ffdb17439394",
        "sourceKey": "source-catalog-0195",
        "legacySequence": 195,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "24bf32bf-4b71-5537-8829-3dca11d794e2",
    "source_key": "source-catalog-0196",
    "legacy_sequence": 196,
    "canonical_name": "OPPO 软件商店",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "应用商店与评论",
    "scenarios": [
      "国内应用商店"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "应用详情",
      "开发者",
      "评分",
      "评论"
    ],
    "monitorable_content": [
      "应用名称",
      "开发者",
      "评分",
      "评论",
      "版本",
      "榜单",
      "关键词",
      "截图"
    ],
    "extractable_clues": [
      "开发者名称",
      "官网",
      "隐私政策",
      "联系方式",
      "评论风险",
      "版本时间"
    ],
    "tracking_fields": [
      "开发者主体",
      "官网域名",
      "隐私政策主体",
      "应用备案/软著线索"
    ],
    "suggested_access": [
      "公开页面监测",
      "应用商店搜索",
      "客户授权账号",
      "第三方合规数据"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=197",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=196",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=167",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "52350b91-212f-5fa7-bef7-f6928f928457",
    "event_changes": {
      "after": {
        "id": "24bf32bf-4b71-5537-8829-3dca11d794e2",
        "sourceKey": "source-catalog-0196",
        "legacySequence": 196,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "3d926fc4-1131-56e1-9d13-e677701bb61a",
    "source_key": "source-catalog-0197",
    "legacy_sequence": 197,
    "canonical_name": "vivo 应用商店",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "应用商店与评论",
    "scenarios": [
      "国内应用商店"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "应用详情",
      "开发者",
      "评分",
      "评论"
    ],
    "monitorable_content": [
      "应用名称",
      "开发者",
      "评分",
      "评论",
      "版本",
      "榜单",
      "关键词",
      "截图"
    ],
    "extractable_clues": [
      "开发者名称",
      "官网",
      "隐私政策",
      "联系方式",
      "评论风险",
      "版本时间"
    ],
    "tracking_fields": [
      "开发者主体",
      "官网域名",
      "隐私政策主体",
      "应用备案/软著线索"
    ],
    "suggested_access": [
      "公开页面监测",
      "应用商店搜索",
      "客户授权账号",
      "第三方合规数据"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=198",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=197",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=168",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "62d37c6c-2688-55fe-be8c-56fb9539a640",
    "event_changes": {
      "after": {
        "id": "3d926fc4-1131-56e1-9d13-e677701bb61a",
        "sourceKey": "source-catalog-0197",
        "legacySequence": 197,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "08c58a31-1314-5df0-a621-2515ed9904d2",
    "source_key": "source-catalog-0198",
    "legacy_sequence": 198,
    "canonical_name": "应用宝",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "应用商店与评论",
    "scenarios": [
      "国内应用商店"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "应用详情",
      "开发者",
      "评分",
      "评论"
    ],
    "monitorable_content": [
      "应用名称",
      "开发者",
      "评分",
      "评论",
      "版本",
      "榜单",
      "关键词",
      "截图"
    ],
    "extractable_clues": [
      "开发者名称",
      "官网",
      "隐私政策",
      "联系方式",
      "评论风险",
      "版本时间"
    ],
    "tracking_fields": [
      "开发者主体",
      "官网域名",
      "隐私政策主体",
      "应用备案/软著线索"
    ],
    "suggested_access": [
      "公开页面监测",
      "应用商店搜索",
      "客户授权账号",
      "第三方合规数据"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=199",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=198",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=169",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "c4d54ae5-93c4-580e-adfd-ca13be000692",
    "event_changes": {
      "after": {
        "id": "08c58a31-1314-5df0-a621-2515ed9904d2",
        "sourceKey": "source-catalog-0198",
        "legacySequence": 198,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "d95d3b34-8370-5252-88d3-82389bd4e790",
    "source_key": "source-catalog-0199",
    "legacy_sequence": 199,
    "canonical_name": "酷安",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "应用商店与评论",
    "scenarios": [
      "应用社区"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "应用详情",
      "评分",
      "评论",
      "用户动态"
    ],
    "monitorable_content": [
      "应用名称",
      "开发者",
      "评分",
      "评论",
      "版本",
      "榜单",
      "关键词",
      "截图"
    ],
    "extractable_clues": [
      "开发者名称",
      "官网",
      "隐私政策",
      "联系方式",
      "评论风险",
      "版本时间"
    ],
    "tracking_fields": [
      "开发者主体",
      "官网域名",
      "隐私政策主体",
      "应用备案/软著线索"
    ],
    "suggested_access": [
      "公开页面监测",
      "应用商店搜索",
      "客户授权账号",
      "第三方合规数据"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=200",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=199",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=170",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "0481ff60-08ae-544e-9752-aa9d8677ad98",
    "event_changes": {
      "after": {
        "id": "d95d3b34-8370-5252-88d3-82389bd4e790",
        "sourceKey": "source-catalog-0199",
        "legacySequence": 199,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "9f6827b7-17a1-554c-954c-668c6ccc36f7",
    "source_key": "source-catalog-0200",
    "legacy_sequence": 200,
    "canonical_name": "七麦数据",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "应用商店与评论",
    "scenarios": [
      "应用数据"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "榜单",
      "关键词",
      "评论",
      "开发者线索"
    ],
    "monitorable_content": [
      "应用名称",
      "开发者",
      "评分",
      "评论",
      "版本",
      "榜单",
      "关键词",
      "截图"
    ],
    "extractable_clues": [
      "开发者名称",
      "官网",
      "隐私政策",
      "联系方式",
      "评论风险",
      "版本时间"
    ],
    "tracking_fields": [
      "开发者主体",
      "官网域名",
      "隐私政策主体",
      "应用备案/软著线索"
    ],
    "suggested_access": [
      "公开页面监测",
      "应用商店搜索",
      "客户授权账号",
      "第三方合规数据"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=201",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=200",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=171",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "386a2b1f-90aa-5da5-9918-851e213ee1e8",
    "event_changes": {
      "after": {
        "id": "9f6827b7-17a1-554c-954c-668c6ccc36f7",
        "sourceKey": "source-catalog-0200",
        "legacySequence": 200,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "8d1b56b2-589d-5639-9853-8e4dc5020c51",
    "source_key": "source-catalog-0201",
    "legacy_sequence": 201,
    "canonical_name": "点点数据",
    "aliases": [],
    "source_kind": "platform",
    "parent_source_id": null,
    "major_category": "应用商店与评论",
    "scenarios": [
      "应用数据"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "榜单",
      "关键词",
      "评论",
      "下载趋势"
    ],
    "monitorable_content": [
      "应用名称",
      "开发者",
      "评分",
      "评论",
      "版本",
      "榜单",
      "关键词",
      "截图"
    ],
    "extractable_clues": [
      "开发者名称",
      "官网",
      "隐私政策",
      "联系方式",
      "评论风险",
      "版本时间"
    ],
    "tracking_fields": [
      "开发者主体",
      "官网域名",
      "隐私政策主体",
      "应用备案/软著线索"
    ],
    "suggested_access": [
      "公开页面监测",
      "应用商店搜索",
      "客户授权账号",
      "第三方合规数据"
    ],
    "compliance_boundary": "仅处理公开可见内容、客户授权材料或合法合规取证材料,账号实名/交易数据需平台披露或法务流程。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=202",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=201",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=172",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "a3ffcfc5-3773-5c73-b3c1-f198390a0aa2",
    "event_changes": {
      "after": {
        "id": "8d1b56b2-589d-5639-9853-8e4dc5020c51",
        "sourceKey": "source-catalog-0201",
        "legacySequence": 201,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "dfbfd71f-d769-5b0a-abc6-232c4c3b21ec",
    "source_key": "source-catalog-0202",
    "legacy_sequence": 202,
    "canonical_name": "Meta Ad Library",
    "aliases": [],
    "source_kind": "provider",
    "parent_source_id": null,
    "major_category": "广告投放与第三方监测数据",
    "scenarios": [
      "海外广告库"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "Facebook/Instagram广告素材",
      "主页",
      "投放地区"
    ],
    "monitorable_content": [
      "广告素材",
      "投放落地页",
      "达人/账号",
      "商品",
      "榜单",
      "行业趋势",
      "传播数据"
    ],
    "extractable_clues": [
      "广告主",
      "素材链接",
      "落地页",
      "账号",
      "商品",
      "投放地区/时间",
      "榜单排名"
    ],
    "tracking_fields": [
      "广告主主体",
      "落地页域名",
      "店铺/商品主体",
      "达人/MCN机构线索"
    ],
    "suggested_access": [
      "公开广告库",
      "客户授权账户",
      "第三方合规订阅数据",
      "人工复核"
    ],
    "compliance_boundary": "仅使用平台公开广告库、客户授权账户或合规第三方数据,不获取非公开投放数据。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=203",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=202",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=173",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "0f9a7b9c-0b32-5d92-8426-386732ce0e2d",
    "event_changes": {
      "after": {
        "id": "dfbfd71f-d769-5b0a-abc6-232c4c3b21ec",
        "sourceKey": "source-catalog-0202",
        "legacySequence": 202,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "f8408b3f-c660-54a0-a748-ccc30729e1d5",
    "source_key": "source-catalog-0203",
    "legacy_sequence": 203,
    "canonical_name": "Google Ads Transparency Center",
    "aliases": [],
    "source_kind": "provider",
    "parent_source_id": null,
    "major_category": "广告投放与第三方监测数据",
    "scenarios": [
      "海外广告库"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "广告主",
      "素材",
      "落地页",
      "地区"
    ],
    "monitorable_content": [
      "广告素材",
      "投放落地页",
      "达人/账号",
      "商品",
      "榜单",
      "行业趋势",
      "传播数据"
    ],
    "extractable_clues": [
      "广告主",
      "素材链接",
      "落地页",
      "账号",
      "商品",
      "投放地区/时间",
      "榜单排名"
    ],
    "tracking_fields": [
      "广告主主体",
      "落地页域名",
      "店铺/商品主体",
      "达人/MCN机构线索"
    ],
    "suggested_access": [
      "公开广告库",
      "客户授权账户",
      "第三方合规订阅数据",
      "人工复核"
    ],
    "compliance_boundary": "仅使用平台公开广告库、客户授权账户或合规第三方数据,不获取非公开投放数据。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=204",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=203",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=174",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "12396305-5108-5a45-ada1-988cea4069ec",
    "event_changes": {
      "after": {
        "id": "f8408b3f-c660-54a0-a748-ccc30729e1d5",
        "sourceKey": "source-catalog-0203",
        "legacySequence": 203,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "24a403a1-4dc0-548c-8ef1-c567effd26fb",
    "source_key": "source-catalog-0204",
    "legacy_sequence": 204,
    "canonical_name": "TikTok Creative Center",
    "aliases": [],
    "source_kind": "provider",
    "parent_source_id": null,
    "major_category": "广告投放与第三方监测数据",
    "scenarios": [
      "海外内容/广告趋势"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "热门广告",
      "素材",
      "关键词",
      "行业趋势"
    ],
    "monitorable_content": [
      "广告素材",
      "投放落地页",
      "达人/账号",
      "商品",
      "榜单",
      "行业趋势",
      "传播数据"
    ],
    "extractable_clues": [
      "广告主",
      "素材链接",
      "落地页",
      "账号",
      "商品",
      "投放地区/时间",
      "榜单排名"
    ],
    "tracking_fields": [
      "广告主主体",
      "落地页域名",
      "店铺/商品主体",
      "达人/MCN机构线索"
    ],
    "suggested_access": [
      "公开广告库",
      "客户授权账户",
      "第三方合规订阅数据",
      "人工复核"
    ],
    "compliance_boundary": "仅使用平台公开广告库、客户授权账户或合规第三方数据,不获取非公开投放数据。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=205",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=204",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=175",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "0827b03e-5cfb-5c69-9591-2d7928bc2a96",
    "event_changes": {
      "after": {
        "id": "24a403a1-4dc0-548c-8ef1-c567effd26fb",
        "sourceKey": "source-catalog-0204",
        "legacySequence": 204,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "3b116a9f-3e0e-514c-8abe-4c4444ec3197",
    "source_key": "source-catalog-0205",
    "legacy_sequence": 205,
    "canonical_name": "巨量创意/巨量算数",
    "aliases": [],
    "source_kind": "provider",
    "parent_source_id": null,
    "major_category": "广告投放与第三方监测数据",
    "scenarios": [
      "国内广告/趋势"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "创意素材",
      "热点",
      "行业趋势",
      "达人/内容线索"
    ],
    "monitorable_content": [
      "广告素材",
      "投放落地页",
      "达人/账号",
      "商品",
      "榜单",
      "行业趋势",
      "传播数据"
    ],
    "extractable_clues": [
      "广告主",
      "素材链接",
      "落地页",
      "账号",
      "商品",
      "投放地区/时间",
      "榜单排名"
    ],
    "tracking_fields": [
      "广告主主体",
      "落地页域名",
      "店铺/商品主体",
      "达人/MCN机构线索"
    ],
    "suggested_access": [
      "公开广告库",
      "客户授权账户",
      "第三方合规订阅数据",
      "人工复核"
    ],
    "compliance_boundary": "仅使用平台公开广告库、客户授权账户或合规第三方数据,不获取非公开投放数据。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=206",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=205",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=176",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "cccc1ced-e98b-59d8-900d-74a3dfd68778",
    "event_changes": {
      "after": {
        "id": "3b116a9f-3e0e-514c-8abe-4c4444ec3197",
        "sourceKey": "source-catalog-0205",
        "legacySequence": 205,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "fd4ff6dc-9d1a-5054-8c63-1131b8334ed1",
    "source_key": "source-catalog-0206",
    "legacy_sequence": 206,
    "canonical_name": "磁力引擎/快手商业化线索",
    "aliases": [],
    "source_kind": "provider",
    "parent_source_id": null,
    "major_category": "广告投放与第三方监测数据",
    "scenarios": [
      "国内广告/趋势"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "素材",
      "达人",
      "行业内容线索"
    ],
    "monitorable_content": [
      "广告素材",
      "投放落地页",
      "达人/账号",
      "商品",
      "榜单",
      "行业趋势",
      "传播数据"
    ],
    "extractable_clues": [
      "广告主",
      "素材链接",
      "落地页",
      "账号",
      "商品",
      "投放地区/时间",
      "榜单排名"
    ],
    "tracking_fields": [
      "广告主主体",
      "落地页域名",
      "店铺/商品主体",
      "达人/MCN机构线索"
    ],
    "suggested_access": [
      "公开广告库",
      "客户授权账户",
      "第三方合规订阅数据",
      "人工复核"
    ],
    "compliance_boundary": "仅使用平台公开广告库、客户授权账户或合规第三方数据,不获取非公开投放数据。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=207",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=206",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=177",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "ae5da92e-ebe3-5715-86b0-56b009364adc",
    "event_changes": {
      "after": {
        "id": "fd4ff6dc-9d1a-5054-8c63-1131b8334ed1",
        "sourceKey": "source-catalog-0206",
        "legacySequence": 206,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "fa718ec8-5ad3-523a-b7ff-7f8c7c59e00f",
    "source_key": "source-catalog-0207",
    "legacy_sequence": 207,
    "canonical_name": "新榜",
    "aliases": [],
    "source_kind": "provider",
    "parent_source_id": null,
    "major_category": "广告投放与第三方监测数据",
    "scenarios": [
      "公众号/新媒体数据"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "公众号",
      "视频号",
      "榜单",
      "文章传播"
    ],
    "monitorable_content": [
      "广告素材",
      "投放落地页",
      "达人/账号",
      "商品",
      "榜单",
      "行业趋势",
      "传播数据"
    ],
    "extractable_clues": [
      "广告主",
      "素材链接",
      "落地页",
      "账号",
      "商品",
      "投放地区/时间",
      "榜单排名"
    ],
    "tracking_fields": [
      "广告主主体",
      "落地页域名",
      "店铺/商品主体",
      "达人/MCN机构线索"
    ],
    "suggested_access": [
      "公开广告库",
      "客户授权账户",
      "第三方合规订阅数据",
      "人工复核"
    ],
    "compliance_boundary": "仅使用平台公开广告库、客户授权账户或合规第三方数据,不获取非公开投放数据。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=208",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=207",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=178",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "b2cb7380-9029-5e04-b6e0-6e2448604cd5",
    "event_changes": {
      "after": {
        "id": "fa718ec8-5ad3-523a-b7ff-7f8c7c59e00f",
        "sourceKey": "source-catalog-0207",
        "legacySequence": 207,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "c763cf64-5207-5ab0-90a1-e2cb626f1fd5",
    "source_key": "source-catalog-0208",
    "legacy_sequence": 208,
    "canonical_name": "飞瓜数据",
    "aliases": [],
    "source_kind": "provider",
    "parent_source_id": null,
    "major_category": "广告投放与第三方监测数据",
    "scenarios": [
      "抖音/快手/直播电商数据"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "达人",
      "直播",
      "商品",
      "短视频",
      "榜单"
    ],
    "monitorable_content": [
      "广告素材",
      "投放落地页",
      "达人/账号",
      "商品",
      "榜单",
      "行业趋势",
      "传播数据"
    ],
    "extractable_clues": [
      "广告主",
      "素材链接",
      "落地页",
      "账号",
      "商品",
      "投放地区/时间",
      "榜单排名"
    ],
    "tracking_fields": [
      "广告主主体",
      "落地页域名",
      "店铺/商品主体",
      "达人/MCN机构线索"
    ],
    "suggested_access": [
      "公开广告库",
      "客户授权账户",
      "第三方合规订阅数据",
      "人工复核"
    ],
    "compliance_boundary": "仅使用平台公开广告库、客户授权账户或合规第三方数据,不获取非公开投放数据。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=209",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=208",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=179",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "77dd2647-daaa-54d6-9131-af286f842fd7",
    "event_changes": {
      "after": {
        "id": "c763cf64-5207-5ab0-90a1-e2cb626f1fd5",
        "sourceKey": "source-catalog-0208",
        "legacySequence": 208,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "3696c3b4-ef54-5c5c-98d0-3bf7300f0078",
    "source_key": "source-catalog-0209",
    "legacy_sequence": 209,
    "canonical_name": "蝉妈妈",
    "aliases": [],
    "source_kind": "provider",
    "parent_source_id": null,
    "major_category": "广告投放与第三方监测数据",
    "scenarios": [
      "抖音/内容电商数据"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "达人",
      "商品",
      "直播",
      "短视频",
      "榜单"
    ],
    "monitorable_content": [
      "广告素材",
      "投放落地页",
      "达人/账号",
      "商品",
      "榜单",
      "行业趋势",
      "传播数据"
    ],
    "extractable_clues": [
      "广告主",
      "素材链接",
      "落地页",
      "账号",
      "商品",
      "投放地区/时间",
      "榜单排名"
    ],
    "tracking_fields": [
      "广告主主体",
      "落地页域名",
      "店铺/商品主体",
      "达人/MCN机构线索"
    ],
    "suggested_access": [
      "公开广告库",
      "客户授权账户",
      "第三方合规订阅数据",
      "人工复核"
    ],
    "compliance_boundary": "仅使用平台公开广告库、客户授权账户或合规第三方数据,不获取非公开投放数据。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=210",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=209",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=180",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "88729d7b-34ed-5d60-b8a5-aeb3143358fe",
    "event_changes": {
      "after": {
        "id": "3696c3b4-ef54-5c5c-98d0-3bf7300f0078",
        "sourceKey": "source-catalog-0209",
        "legacySequence": 209,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "08249d4f-cd86-58e4-96bd-4ae3280dc857",
    "source_key": "source-catalog-0210",
    "legacy_sequence": 210,
    "canonical_name": "千瓜数据",
    "aliases": [],
    "source_kind": "provider",
    "parent_source_id": null,
    "major_category": "广告投放与第三方监测数据",
    "scenarios": [
      "小红书数据"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "达人",
      "笔记",
      "品牌",
      "投放",
      "榜单"
    ],
    "monitorable_content": [
      "广告素材",
      "投放落地页",
      "达人/账号",
      "商品",
      "榜单",
      "行业趋势",
      "传播数据"
    ],
    "extractable_clues": [
      "广告主",
      "素材链接",
      "落地页",
      "账号",
      "商品",
      "投放地区/时间",
      "榜单排名"
    ],
    "tracking_fields": [
      "广告主主体",
      "落地页域名",
      "店铺/商品主体",
      "达人/MCN机构线索"
    ],
    "suggested_access": [
      "公开广告库",
      "客户授权账户",
      "第三方合规订阅数据",
      "人工复核"
    ],
    "compliance_boundary": "仅使用平台公开广告库、客户授权账户或合规第三方数据,不获取非公开投放数据。",
    "priority": "P1",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=211",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=210",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=181",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "0b31deaa-7ab1-509b-b2b9-277e80c858c6",
    "event_changes": {
      "after": {
        "id": "08249d4f-cd86-58e4-96bd-4ae3280dc857",
        "sourceKey": "source-catalog-0210",
        "legacySequence": 210,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "2d572d45-86ef-5156-9a7b-79c9e05d50d9",
    "source_key": "source-catalog-0211",
    "legacy_sequence": 211,
    "canonical_name": "灰豚数据",
    "aliases": [],
    "source_kind": "provider",
    "parent_source_id": null,
    "major_category": "广告投放与第三方监测数据",
    "scenarios": [
      "短视频/直播数据"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "达人",
      "商品",
      "直播",
      "短视频"
    ],
    "monitorable_content": [
      "广告素材",
      "投放落地页",
      "达人/账号",
      "商品",
      "榜单",
      "行业趋势",
      "传播数据"
    ],
    "extractable_clues": [
      "广告主",
      "素材链接",
      "落地页",
      "账号",
      "商品",
      "投放地区/时间",
      "榜单排名"
    ],
    "tracking_fields": [
      "广告主主体",
      "落地页域名",
      "店铺/商品主体",
      "达人/MCN机构线索"
    ],
    "suggested_access": [
      "公开广告库",
      "客户授权账户",
      "第三方合规订阅数据",
      "人工复核"
    ],
    "compliance_boundary": "仅使用平台公开广告库、客户授权账户或合规第三方数据,不获取非公开投放数据。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=212",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=211",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=182",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "78b496ab-f862-509d-9c34-25d469c3e009",
    "event_changes": {
      "after": {
        "id": "2d572d45-86ef-5156-9a7b-79c9e05d50d9",
        "sourceKey": "source-catalog-0211",
        "legacySequence": 211,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "d3bf1ced-92ce-5ab2-b855-53ad11bd92ce",
    "source_key": "source-catalog-0212",
    "legacy_sequence": 212,
    "canonical_name": "DataEye",
    "aliases": [],
    "source_kind": "provider",
    "parent_source_id": null,
    "major_category": "广告投放与第三方监测数据",
    "scenarios": [
      "广告/投放情报"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "素材",
      "广告主",
      "落地页",
      "行业趋势"
    ],
    "monitorable_content": [
      "广告素材",
      "投放落地页",
      "达人/账号",
      "商品",
      "榜单",
      "行业趋势",
      "传播数据"
    ],
    "extractable_clues": [
      "广告主",
      "素材链接",
      "落地页",
      "账号",
      "商品",
      "投放地区/时间",
      "榜单排名"
    ],
    "tracking_fields": [
      "广告主主体",
      "落地页域名",
      "店铺/商品主体",
      "达人/MCN机构线索"
    ],
    "suggested_access": [
      "公开广告库",
      "客户授权账户",
      "第三方合规订阅数据",
      "人工复核"
    ],
    "compliance_boundary": "仅使用平台公开广告库、客户授权账户或合规第三方数据,不获取非公开投放数据。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=213",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=212",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=183",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "d3cc0d1c-e890-5b4f-b8e6-ae05c6c0ebe1",
    "event_changes": {
      "after": {
        "id": "d3bf1ced-92ce-5ab2-b855-53ad11bd92ce",
        "sourceKey": "source-catalog-0212",
        "legacySequence": 212,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "f09d77fe-436b-51af-b792-869350999b3e",
    "source_key": "source-catalog-0213",
    "legacy_sequence": 213,
    "canonical_name": "AppGrowing",
    "aliases": [],
    "source_kind": "provider",
    "parent_source_id": null,
    "major_category": "广告投放与第三方监测数据",
    "scenarios": [
      "广告/应用投放情报"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "素材",
      "广告主",
      "落地页",
      "应用"
    ],
    "monitorable_content": [
      "广告素材",
      "投放落地页",
      "达人/账号",
      "商品",
      "榜单",
      "行业趋势",
      "传播数据"
    ],
    "extractable_clues": [
      "广告主",
      "素材链接",
      "落地页",
      "账号",
      "商品",
      "投放地区/时间",
      "榜单排名"
    ],
    "tracking_fields": [
      "广告主主体",
      "落地页域名",
      "店铺/商品主体",
      "达人/MCN机构线索"
    ],
    "suggested_access": [
      "公开广告库",
      "客户授权账户",
      "第三方合规订阅数据",
      "人工复核"
    ],
    "compliance_boundary": "仅使用平台公开广告库、客户授权账户或合规第三方数据,不获取非公开投放数据。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=214",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=213",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=184",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "f039d179-3a1b-54c3-9ed3-9054a99feac6",
    "event_changes": {
      "after": {
        "id": "f09d77fe-436b-51af-b792-869350999b3e",
        "sourceKey": "source-catalog-0213",
        "legacySequence": 213,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "47af86a5-9f58-5b43-b168-4da023980a6b",
    "source_key": "source-catalog-0214",
    "legacy_sequence": 214,
    "canonical_name": "克劳锐",
    "aliases": [],
    "source_kind": "provider",
    "parent_source_id": null,
    "major_category": "广告投放与第三方监测数据",
    "scenarios": [
      "内容生态/达人数据"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "达人",
      "机构",
      "榜单",
      "内容趋势"
    ],
    "monitorable_content": [
      "广告素材",
      "投放落地页",
      "达人/账号",
      "商品",
      "榜单",
      "行业趋势",
      "传播数据"
    ],
    "extractable_clues": [
      "广告主",
      "素材链接",
      "落地页",
      "账号",
      "商品",
      "投放地区/时间",
      "榜单排名"
    ],
    "tracking_fields": [
      "广告主主体",
      "落地页域名",
      "店铺/商品主体",
      "达人/MCN机构线索"
    ],
    "suggested_access": [
      "公开广告库",
      "客户授权账户",
      "第三方合规订阅数据",
      "人工复核"
    ],
    "compliance_boundary": "仅使用平台公开广告库、客户授权账户或合规第三方数据,不获取非公开投放数据。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=215",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=214",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=185",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "124e0fe1-eade-557d-bb58-e664badbb17e",
    "event_changes": {
      "after": {
        "id": "47af86a5-9f58-5b43-b168-4da023980a6b",
        "sourceKey": "source-catalog-0214",
        "legacySequence": 214,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  },
  {
    "id": "a3431858-9abc-5820-921b-edd59a02372d",
    "source_key": "source-catalog-0215",
    "legacy_sequence": 215,
    "canonical_name": "西瓜数据",
    "aliases": [],
    "source_kind": "provider",
    "parent_source_id": null,
    "major_category": "广告投放与第三方监测数据",
    "scenarios": [
      "公众号/视频号数据"
    ],
    "regions": [
      "全球",
      "中国大陆"
    ],
    "entry_modules": [
      "账号",
      "文章",
      "榜单",
      "传播数据"
    ],
    "monitorable_content": [
      "广告素材",
      "投放落地页",
      "达人/账号",
      "商品",
      "榜单",
      "行业趋势",
      "传播数据"
    ],
    "extractable_clues": [
      "广告主",
      "素材链接",
      "落地页",
      "账号",
      "商品",
      "投放地区/时间",
      "榜单排名"
    ],
    "tracking_fields": [
      "广告主主体",
      "落地页域名",
      "店铺/商品主体",
      "达人/MCN机构线索"
    ],
    "suggested_access": [
      "公开广告库",
      "客户授权账户",
      "第三方合规订阅数据",
      "人工复核"
    ],
    "compliance_boundary": "仅使用平台公开广告库、客户授权账户或合规第三方数据,不获取非公开投放数据。",
    "priority": "P2",
    "coverage_status": "not_covered",
    "delivery_status": "planned",
    "review_status": "needs_review",
    "runtime_status": "unknown",
    "owner": null,
    "connector_hints": [],
    "notes": null,
    "tags": [],
    "evidence_refs": [
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.base.txt#sha256=79a781519dca1c2b29ea24e2eddec54a4855de84cf19b981c8b5e37a4404066b&row=216",
        "label": "Source catalog base row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/03.txt#sha256=a29a493d78aac09b7f39d8993354c6dbcbb431a519033ae67005f9916f81dadd&row=215",
        "label": "Source catalog detail row"
      },
      {
        "type": "dataset",
        "key": "spec_docs/data_source/02.weifugai.txt#sha256=be02dfe299bea671a9da2ee6460058f1be4452e0b8d5afea7adccb505f943059&row=186",
        "label": "未覆盖 filtered view row"
      }
    ],
    "custom_fields": {
      "importProvenance": {
        "batch": "mx-insight-hub-source-catalog-v1",
        "batchSha256": "24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
        "parser": "fixed-schema-tsv-v1"
      },
      "legacy": {
        "baseCoverageLabel": "未覆盖",
        "baseRegionLabel": "全球/中国大陆",
        "baseOwnerRaw": null,
        "baseNoteRaw": null,
        "detailReviewLabel": "待补充",
        "detailOwnerRaw": null,
        "detailNoteRaw": null
      }
    },
    "revision": 1,
    "archived_at": null,
    "imported_from": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7",
    "created_at": "2026-08-27T00:00:00.000Z",
    "updated_at": "2026-08-27T00:00:00.000Z",
    "event_id": "c410eaf0-586e-55d4-8744-ed5191b223e8",
    "event_changes": {
      "after": {
        "id": "a3431858-9abc-5820-921b-edd59a02372d",
        "sourceKey": "source-catalog-0215",
        "legacySequence": 215,
        "revision": 1,
        "importedFrom": "mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7"
      }
    }
  }
]
$source_catalog_seed$::jsonb
) AS seed(
  id uuid,
  source_key text,
  legacy_sequence integer,
  canonical_name text,
  aliases text[],
  source_kind text,
  parent_source_id uuid,
  major_category text,
  scenarios text[],
  regions text[],
  entry_modules text[],
  monitorable_content text[],
  extractable_clues text[],
  tracking_fields text[],
  suggested_access text[],
  compliance_boundary text,
  priority text,
  coverage_status text,
  delivery_status text,
  review_status text,
  runtime_status text,
  owner text,
  connector_hints text[],
  notes text,
  tags text[],
  evidence_refs jsonb,
  custom_fields jsonb,
  revision integer,
  archived_at timestamptz,
  imported_from text,
  created_at timestamptz,
  updated_at timestamptz,
  event_id uuid,
  event_changes jsonb
);

INSERT INTO catalog.source_catalog_entries
  (id, source_key, legacy_sequence, canonical_name, aliases, source_kind,
   parent_source_id, major_category, scenarios, regions, entry_modules,
   monitorable_content, extractable_clues, tracking_fields, suggested_access,
   compliance_boundary, priority, coverage_status, delivery_status, review_status,
   runtime_status, owner, connector_hints, notes, tags, evidence_refs, custom_fields,
   revision, archived_at, imported_from, created_at, updated_at)
SELECT
  id, source_key, legacy_sequence, canonical_name, aliases, source_kind,
  parent_source_id, major_category, scenarios, regions, entry_modules,
  monitorable_content, extractable_clues, tracking_fields, suggested_access,
  compliance_boundary, priority, coverage_status, delivery_status, review_status,
  runtime_status, owner, connector_hints, notes, tags, evidence_refs, custom_fields,
  revision, archived_at, imported_from, created_at, updated_at
FROM source_catalog_seed_036
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO catalog.source_catalog_events
  (id, entry_id, event_type, actor, from_revision, to_revision, changes, created_at)
SELECT
  seed.event_id, entry.id, 'seed_import', 'migration-036', NULL, entry.revision,
  seed.event_changes, seed.created_at
FROM source_catalog_seed_036 seed
JOIN catalog.source_catalog_entries entry USING (source_key)
ON CONFLICT (id) DO NOTHING;

DO $$
DECLARE
  seeded_total integer;
  covered_total integer;
  not_covered_total integer;
  complete_total integer;
BEGIN
  SELECT
    count(*),
    count(*) FILTER (WHERE coverage_status = 'covered'),
    count(*) FILTER (WHERE coverage_status = 'not_covered'),
    count(*) FILTER (WHERE delivery_status = 'complete')
  INTO seeded_total, covered_total, not_covered_total, complete_total
  FROM catalog.source_catalog_entries
  WHERE imported_from = 'mx-insight-hub-source-catalog-v1:24222366023014f4ec62cb1abde5f0d38fe8563d9918db8c7e8eb08fe12e83b7';

  IF ROW(seeded_total, covered_total, not_covered_total, complete_total)
     IS DISTINCT FROM ROW(215, 29, 186, 2) THEN
    RAISE EXCEPTION
      'source catalog seed validation failed: total=%, covered=%, not_covered=%, complete=%',
      seeded_total, covered_total, not_covered_total, complete_total;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM catalog.source_catalog_entries
    WHERE legacy_sequence = 62
      AND canonical_name = '抖音电商'
      AND aliases = ARRAY['抖音小店']::text[]
  ) THEN
    RAISE EXCEPTION 'source catalog seed validation failed for legacy sequence 62 alias';
  END IF;
END
$$;

COMMENT ON TABLE catalog.source_catalog_entries IS
  'Hub-owned governed source directory. Coverage, delivery, review and runtime are separate state axes.';

COMMENT ON TABLE catalog.source_catalog_events IS
  'Append-only audit events for governed source catalog revisions.';
