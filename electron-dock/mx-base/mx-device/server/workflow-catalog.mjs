// Logical command codes; only the simulator executes this catalog today.
const LEGACY_COMMANDS = [
  {
    code: "xianyu.refresh",
    name: "闲鱼下拉刷新",
    appId: "xianyu",
    estimateMs: 1800,
    effect: "read",
    mapping: "仅模拟；待 adapter：刷新完成与结构化结果证据",
  },
  {
    code: "app.open",
    name: "打开目标 App",
    appId: null,
    estimateMs: 1000,
    effect: "navigation",
    mapping: "Mobile-Agent action: open_app（待独占/回执适配）",
  },
  {
    code: "weibo.list",
    name: "微博列表",
    appId: "weibo",
    estimateMs: 1800,
    effect: "read",
    mapping: "待 adapter：列表识别与结构化结果",
  },
  {
    code: "weibo.search",
    name: "微博搜索",
    appId: "weibo",
    estimateMs: 2200,
    effect: "read",
    mapping: "待 adapter：输入、搜索与结果验证",
  },
  {
    code: "weibo.like",
    name: "微博点赞",
    appId: "weibo",
    estimateMs: 1200,
    effect: "write",
    mapping: "Mobile-Agent 有 like 动作；目标/结果核验待适配",
  },
  {
    code: "xhs.list",
    name: "小红书列表",
    appId: "xhs",
    estimateMs: 1800,
    effect: "read",
    mapping: "待 adapter：列表与页码证据",
  },
  {
    code: "xhs.search",
    name: "小红书搜索",
    appId: "xhs",
    estimateMs: 2200,
    effect: "read",
    mapping: "旧 PoC /api/search；组合执行尚未接入",
  },
  {
    code: "xhs.search.next",
    name: "小红书下一页",
    appId: "xhs",
    estimateMs: 1600,
    effect: "read",
    mapping: "旧 PoC /api/next；无可恢复游标",
  },
  {
    code: "xhs.note.detail",
    name: "小红书详情",
    appId: "xhs",
    estimateMs: 2000,
    effect: "read",
    mapping: "旧 PoC /api/note；组合执行尚未接入",
  },
  {
    code: "xhs.get_note_detail.ocr",
    name: "正文 OCR",
    appId: "xhs",
    estimateMs: 2600,
    effect: "read",
    mapping: "已有 screen.png 只读截图；OCR/完整正文验证待实现",
  },
  {
    code: "session.home",
    name: "回到工作起点",
    appId: null,
    estimateMs: 800,
    effect: "navigation",
    mapping: "Mobile-Agent 有 home；收尾验证待适配",
  },
  {
    code: "session.back",
    name: "返回上一层",
    appId: null,
    estimateMs: 800,
    effect: "navigation",
    mapping: "Mobile-Agent 有 back；页面状态核验待适配",
  },
  {
    code: "session.restore",
    name: "恢复大任务上下文",
    appId: null,
    estimateMs: 1000,
    effect: "navigation",
    mapping: "仅模拟器具备检查点恢复；真实 adapter 未声明该能力",
    internal: true,
  },
];
// Canonical actions describe semantics; bindings name installed adapter handlers,
// never arbitrary URLs, credentials, scripts, or ADB shell text.
export const COMMAND_ACTIONS = [
  "open",
  "search",
  "list",
  "refresh",
  "next",
  "scroll",
  "detail",
  "ocr",
  "back",
  "home",
  "restore",
  "like",
];
const textSchema = (maxLength = 200) => ({ type: "string", maxLength });
const objectSchema = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const commonInput = {
  keyword: textSchema(),
  target: textSchema(),
};
const itemSchema = objectSchema({ id: textSchema(), title: textSchema(500) });
const listOutput = objectSchema({
  keyword: textSchema(),
  page: { type: ["integer", "null"], minimum: 1 },
  items: { type: "array", maxItems: 100, items: itemSchema },
});
const detailOutput = objectSchema({
  target: textSchema(),
  fullText: textSchema(10000),
  complete: { type: "boolean" },
});
const outputFor = (action) =>
  action === "open"
    ? objectSchema({ foregroundAppId: textSchema() })
    : action === "home"
      ? objectSchema({ home: { type: "boolean" } })
      : action === "back"
        ? objectSchema({ backed: { type: "boolean" } })
        : action === "restore"
          ? objectSchema({
              restoredStep: { type: "integer", minimum: 0 },
              appId: textSchema(),
            })
          : action === "like"
            ? objectSchema({ target: textSchema(), liked: { type: "boolean" } })
            : ["detail", "ocr"].includes(action)
              ? detailOutput
              : listOutput;
const actionFor = (code) =>
  code.endsWith("ocr")
    ? "ocr"
    : code.endsWith(".next")
      ? "next"
      : code.split(".").at(-1);
const enrich = (command) => ({
  ...command,
  action: command.action || actionFor(command.code),
  timeoutMs: Math.max(10000, command.estimateMs * 3),
  inputSchema: objectSchema(commonInput, []),
  outputSchema: structuredClone(
    outputFor(command.action || actionFor(command.code)),
  ),
  bindings: [],
});
const pddGoods = objectSchema({
  id: textSchema(),
  goodsId: textSchema(),
  title: textSchema(500),
  priceCents: { type: "integer", minimum: 0 },
});
const pddListOutput = objectSchema({
  keyword: textSchema(),
  page: { type: ["integer", "null"], minimum: 1 },
  items: { type: "array", maxItems: 100, items: pddGoods },
});
const pddCommand = (action, name, estimateMs, effect = "read") => ({
  ...enrich({
    code: `pdd.${action}`,
    name,
    appId: "pdd",
    action,
    estimateMs,
    effect,
  }),
  mapping: "拼多多模拟契约；PoC / ADB / 自定义 handler 引用待安装和真机验收",
  outputSchema: structuredClone(
    ["search", "refresh", "next", "scroll"].includes(action)
      ? pddListOutput
      : action === "detail"
        ? objectSchema({
            ...detailOutput.properties,
            goodsId: textSchema(),
            title: textSchema(500),
            priceCents: { type: "integer", minimum: 0 },
          })
        : action === "ocr"
          ? objectSchema({
              ...detailOutput.properties,
              blocks: {
                type: "array",
                maxItems: 100,
                items: objectSchema({
                  text: textSchema(2000),
                  confidence: { type: "number", minimum: 0, maximum: 1 },
                }),
              },
            })
          : outputFor(action),
  ),
  // References advertise the integration contract only. They do not enable real dispatch.
  bindings: ["poc", "adb", "custom"].map((kind) => ({
    kind,
    adapterId: `pdd-${kind}.v1`,
    operation: action,
  })),
});
export const COMMANDS = [
  ...LEGACY_COMMANDS.map(enrich),
  pddCommand("open", "拼多多 · 打开应用", 1500, "navigation"),
  pddCommand("search", "拼多多 · 搜索商品", 3200),
  pddCommand("refresh", "拼多多 · 下拉刷新", 2300),
  pddCommand("next", "拼多多 · 下一页", 2600),
  pddCommand("scroll", "拼多多 · 滚动浏览", 1400),
  pddCommand("detail", "拼多多 · 商品详情", 3000),
  pddCommand("ocr", "拼多多 · 截图 OCR", 4200),
  pddCommand("back", "拼多多 · 返回上一层", 900, "navigation"),
  pddCommand("home", "拼多多 · 回到首页", 1100, "navigation"),
];
export const BUILTIN_COMMAND_DEFINITIONS = COMMANDS.map((command) => ({
  ...structuredClone(command),
  id: `sim:${command.code}:1`,
  mode: "sim",
  version: 1,
  archived: false,
  createdAt: 0,
}));

export const commandByCode = (code) => COMMANDS.find((c) => c.code === code);
const def = (code, name, appId, loop, steps, resumable = false) => ({
  id: `sim:${code}:1`,
  mode: "sim",
  code,
  name,
  appId,
  loop,
  steps,
  resumable,
  version: 1,
  createdAt: 0,
  executionModel: "checkpoint-session.v1",
});
export const BUILTIN_DEFINITIONS = [
  def("xianyu.refresh", "闲鱼 · 下拉刷新", "xianyu", "small", [
    { code: "app.open", repeat: 1 },
    { code: "xianyu.refresh", repeat: 1 },
  ]),
  def("weibo.list", "微博 · 浏览列表", "weibo", "small", [
    { code: "app.open", repeat: 1 },
    { code: "weibo.list", repeat: 1 },
  ]),
  def("weibo.search", "微博 · 搜索", "weibo", "small", [
    { code: "app.open", repeat: 1 },
    { code: "weibo.search", repeat: 1 },
  ]),
  def("weibo.like", "微博 · 点赞（模拟）", "weibo", "small", [
    { code: "app.open", repeat: 1 },
    { code: "weibo.like", repeat: 1 },
  ]),
  def("xhs.list", "小红书 · 浏览列表", "xhs", "small", [
    { code: "app.open", repeat: 1 },
    { code: "xhs.list", repeat: 1 },
  ]),
  def("xhs.detail", "小红书 · 详情", "xhs", "small", [
    { code: "app.open", repeat: 1 },
    { code: "xhs.note.detail", repeat: 1 },
  ]),
  def("xhs.ocr", "小红书 · get_note_detail（OCR）", "xhs", "small", [
    { code: "app.open", repeat: 1 },
    { code: "xhs.get_note_detail.ocr", repeat: 1 },
  ]),
  def(
    "xhs.search10",
    "小红书 · 搜索第 1–10 页",
    "xhs",
    "large",
    [
      { code: "app.open", repeat: 1 },
      { code: "xhs.search", repeat: 1 },
      { code: "xhs.search.next", repeat: 9 },
      { code: "session.home", repeat: 1 },
    ],
    true,
  ),
  def(
    "weibo.search_batch",
    "微博 · 连续搜索 5 次",
    "weibo",
    "large",
    [
      { code: "app.open", repeat: 1 },
      { code: "weibo.search", repeat: 5 },
      { code: "session.home", repeat: 1 },
    ],
    true,
  ),
];
// PDD operations are bounded simulated templates. Search pagination stays on one phone.
BUILTIN_DEFINITIONS.push(
  def("pdd.refresh", "拼多多 · 刷新商品列表", "pdd", "small", [
    { code: "pdd.open", repeat: 1 },
    { code: "pdd.refresh", repeat: 1 },
  ]),
  def("pdd.search", "拼多多 · 关键词搜索", "pdd", "small", [
    { code: "pdd.open", repeat: 1 },
    { code: "pdd.search", repeat: 1 },
  ]),
  def("pdd.detail", "拼多多 · 搜索并获取商品详情", "pdd", "small", [
    { code: "pdd.open", repeat: 1 },
    { code: "pdd.search", repeat: 1 },
    { code: "pdd.detail", repeat: 1 },
    { code: "pdd.back", repeat: 1 },
  ]),
  def("pdd.search_detail_ocr", "拼多多 · 商品详情 OCR", "pdd", "large", [
    { code: "pdd.open", repeat: 1 },
    { code: "pdd.search", repeat: 1 },
    { code: "pdd.detail", repeat: 1 },
    { code: "pdd.ocr", repeat: 1 },
    { code: "pdd.back", repeat: 1 },
  ]),
  def("pdd.search5", "拼多多 · 搜索前 5 页", "pdd", "large", [
    { code: "pdd.open", repeat: 1 },
    { code: "pdd.search", repeat: 1 },
    { code: "pdd.next", repeat: 4 },
    { code: "pdd.home", repeat: 1 },
  ]),
  def("pdd.browse", "拼多多 · 连续滚动浏览", "pdd", "large", [
    { code: "pdd.open", repeat: 1 },
    { code: "pdd.refresh", repeat: 1 },
    { code: "pdd.scroll", repeat: 5 },
    { code: "pdd.home", repeat: 1 },
  ]),
);
// Pin version-one seeds and data dependencies just like authored task versions.
for (const definition of BUILTIN_DEFINITIONS) {
  for (const step of definition.steps) {
    if (
      ["pdd.detail", "pdd.search_detail_ocr"].includes(definition.code) &&
      ["pdd.detail", "pdd.ocr"].includes(step.code)
    ) {
      step.input = { target: { fromStep: 1, path: ["items", 0, "goodsId"] } };
    }
    step.commandVersion = 1;
    step.commandDefinition = structuredClone(
      BUILTIN_COMMAND_DEFINITIONS.find((command) => command.code === step.code),
    );
  }
}
export const DEMO_RACK = "调度实验机架";

// A preview and its test job share the same bounded preparation sequence.
export function adapterTestDefinition(
  code,
  appId,
  catalog = BUILTIN_COMMAND_DEFINITIONS,
) {
  const commands = catalog.filter(
    (c) => !c.archived && !c.internal && (!c.appId || c.appId === appId),
  );
  const command = commands.find((c) => c.code === code);
  if (!["xhs", "weibo", "xianyu", "pdd"].includes(appId) || !command)
    return null;
  const open =
    commands.find((c) => c.appId === appId && c.action === "open") ||
    commands.find((c) => c.code === "app.open");
  if (command.action !== "open" && !open) return null;
  const selected = command.action === "open" ? [] : [open];
  if (command.action === "next") {
    const search = commands.find(
      (c) => c.appId === appId && c.action === "search",
    );
    if (!search) return null;
    selected.push(search);
  }
  selected.push(command);
  return {
    id: `adapter-test:${appId}:${code}:${command.version}`,
    mode: "sim",
    code: `adapter.${appId}.${code}`,
    name: `调试 · ${command.name}`,
    appId,
    loop: "small",
    version: command.version,
    steps: selected.map((c) => ({
      code: c.code,
      repeat: 1,
      commandVersion: c.version,
    })),
    resumable: false,
    executionModel: "checkpoint-session.v1",
  };
}
