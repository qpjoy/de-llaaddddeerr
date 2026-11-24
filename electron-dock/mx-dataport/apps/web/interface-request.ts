import type { InterfaceOperation } from "./interface-catalog";

type RequestObject = Record<string, unknown>;

export function parseRequestObject(value: string): RequestObject | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as RequestObject;
    }
  } catch {
    return undefined;
  }
}

// The catalog keeps the spreadsheet's examples verbatim. Extract the body
// from the JSON or single-quoted cURL examples without interpreting shell code.
export function requestSample(example?: string): RequestObject | undefined {
  if (!example) return undefined;
  const json = example.trim().match(/^\{[\s\S]*?\}(?=\s*\n\s*curl\b|\s*$)/)?.[0]
    ?? example.match(/(?:^|\s)-d\s+'([^']+)'/)?.[1];
  return json ? parseRequestObject(json) : undefined;
}

type Requirement = boolean | "conditional";
type Field = { name: string; type: string; description: string; required?: Requirement };

const descriptions: Record<string, string> = {
  platform: "目标平台",
  query: "查询内容",
  pageSize: "每页条数",
  count: "每页评论条数",
  contentId: "内容 ID 或帖子 URL 至少填写一项",
  note_id: "小红书笔记 ID",
  sort: "排序方式",
  marketplace: "目标电商平台",
  deliveryMode: "数据获取方式",
  params: "接口的附加参数",
  "params.keyword": "搜索关键词",
  "params.sort": "排序方式",
  "params.offset": "分页偏移量",
  "params.publish_time": "发布时间范围",
  "params.duration": "视频时长范围",
  "params.raw": "是否返回原始数据",
  sourceScope: "数据来源范围",
  scope: "检索对象范围",
  matchMode: "匹配模式",
  chatId: "群组或频道标识",
  before: "锚点前的条数",
  after: "锚点后的条数",
  cursor: "上一页返回的游标",
  binding: "数据源绑定范围",
  timeField: "查询使用的时间字段",
  mode: "查询模式",
  limit: "最大返回条数",
  videoId: "视频 ID 或视频 URL 至少填写一项",
  channelUrl: "频道 URL 或 channelId 至少填写一项",
  maxVideos: "最多检索的视频数",
  maxComments: "本页最多返回的评论数",
};

// Required flags are only set when the Hub contract documents them.
const requirements: Record<string, Record<string, Requirement>> = {
  "/api/v1/data/search": { platform: true, query: true, pageSize: false, params: false },
  "/api/v1/search/post-comments": { platform: true, contentId: "conditional", count: false },
  "/api/v1/data/social/post-comments": { platform: true, contentId: "conditional", count: false },
  "/api/v1/data/xiaohongshu/notes/comments": { note_id: true, sort: false },
  "/api/v1/data/ecommerce/products/search": { marketplace: true, query: true, deliveryMode: false },
  "/api/v1/data/youtube/comments": { videoId: "conditional", maxComments: false },
  "/api/v1/data/youtube/channel-comments": { channelUrl: "conditional", maxVideos: false, maxComments: false },
  "/api/v1/data/telegram/messages": { chatId: true, sourceScope: false, pageSize: false },
  "/api/v1/data/canonical/items/{id}/timeline": { before: false, after: false, cursor: false },
};

export function requestFields(operation: InterfaceOperation, sample: RequestObject): Field[] {
  const required = operation.path ? requirements[operation.path] : undefined;
  const fields: Field[] = [];
  function addFields(object: RequestObject, prefix = "") {
    for (const [key, value] of Object.entries(object)) {
      const name = prefix + key;
      const type = value === null ? "null" : Array.isArray(value) ? "array"
        : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value;
      fields.push({ name, type, description: descriptions[name] ?? "见请求示例", required: required?.[name] });
      if (type === "object") addFields(value as RequestObject, `${name}.`);
    }
  }
  addFields(sample);
  return fields;
}
