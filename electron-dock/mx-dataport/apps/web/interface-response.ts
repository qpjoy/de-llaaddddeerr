type ResponseField = { name: string; type: string; description: string };

const descriptions: Record<string, string> = {
  contractVersion: "响应契约版本",
  requestId: "请求编号",
  request_id: "请求编号",
  code: "响应状态码",
  status: "响应状态",
  message: "响应消息",
  data: "响应数据",
  items: "结果列表",
  id: "记录标识",
  externalId: "源平台记录标识",
  contentId: "内容标识",
  postId: "帖子标识",
  videoId: "视频标识",
  noteId: "笔记标识",
  commentId: "评论标识",
  platform: "数据所属平台",
  query: "查询内容",
  keyword: "搜索关键词",
  title: "标题",
  text: "文本内容",
  content: "内容",
  summary: "内容摘要",
  url: "资源链接",
  author: "作者信息",
  name: "名称",
  avatarUrl: "头像链接",
  publishedAt: "发布时间",
  collectedAt: "采集时间",
  media: "媒体资源",
  images: "图片列表",
  metrics: "统计指标",
  likes: "点赞数",
  likeCount: "点赞数",
  shares: "分享数",
  views: "浏览量",
  comments: "评论信息",
  replyCount: "回复数",
  page: "页码或分页信息",
  pageInfo: "分页信息",
  pageIndex: "页码",
  pageSize: "每页条数",
  returnedCount: "本次返回条数",
  hasMore: "是否还有后续结果",
  nextCursor: "下一页游标",
  warnings: "响应提示",
  meta: "响应元数据",
};

function observedType(values: unknown[]): string {
  const types = new Set<string>();
  const arrayItems: unknown[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      types.add("array");
      arrayItems.push(...value);
    } else {
      types.add(value === null ? "null" : typeof value === "number" && Number.isInteger(value) ? "integer" : typeof value);
    }
  }
  if (!arrayItems.length) return [...types].join(" | ");
  const itemType = observedType(arrayItems);
  return [...types].map(type => type === "array"
    ? (itemType.includes(" | ") ? `(${itemType})[]` : `${itemType}[]`)
    : type).join(" | ");
}

export function responseFields(example?: string): ResponseField[] {
  if (!example) return [];
  let response: unknown;
  try {
    response = JSON.parse(example);
  } catch {
    return [];
  }
  const fields: ResponseField[] = [];

  function visit(values: unknown[], path: string) {
    const properties = new Map<string, unknown[]>();
    const arrayItems: unknown[] = [];
    for (const value of values) {
      if (Array.isArray(value)) {
        arrayItems.push(...value);
      } else if (value !== null && typeof value === "object") {
        for (const [key, fieldValue] of Object.entries(value)) {
          const observed = properties.get(key);
          if (observed) observed.push(fieldValue);
          else properties.set(key, [fieldValue]);
        }
      }
    }
    for (const [key, observed] of properties) {
      const name = /^[\w-]+$/.test(key)
        ? (path ? `${path}.${key}` : key)
        : `${path}[${JSON.stringify(key)}]`;
      fields.push({
        name,
        type: observedType(observed),
        description: Object.hasOwn(descriptions, key) ? descriptions[key] : "见响应示例",
      });
      visit(observed, name);
    }
    if (arrayItems.length) visit(arrayItems, `${path}[]`);
  }

  visit([response], "");
  return fields;
}
