// Synthetic content for simulated phones: titles, prices and texts that read
// like each platform, derived deterministically from the keyword and an id.
// Shared by the simulator (receipts) and the UI (phone screens). It is never
// real app data; screens that show it are marked as synthetic.

/** FNV-1a: a stable 32-bit hash for deterministic choices. */
export function hash(text) {
  let h = 2166136261;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export const pick = (list, seed) => list[seed % list.length];

// What an empty keyword means on each platform's own feed.
export const FEED_TOPIC = {
  xhs: "周末穿搭",
  weibo: "今日热点",
  xianyu: "闲置数码",
  pdd: "家居好物",
};
const TITLES = {
  xhs: [
    (k) => `${k}真实测评｜用了一个月说说感受`,
    (k) => `平价${k}合集，学生党闭眼入`,
    (k) => `${k}避坑指南！这几点一定要看`,
    (k) => `被问爆的${k}，终于整理好了`,
    (k) => `${k}怎么选？看这一篇就够了`,
    (k) => `周末打卡${k}，氛围感拉满`,
    (k) => `${k}｜小众但好用的宝藏清单`,
  ],
  weibo: [
    (k) => `#${k}# 今天又上热搜了，你怎么看？`,
    (k) => `关于${k}，说几句心里话`,
    (k) => `${k}最新进展汇总（持续更新）`,
    (k) => `刚刚，${k}有新消息了`,
    (k) => `有人了解${k}吗？求科普`,
  ],
  xianyu: [
    (k) => `自用${k}，九成新转让`,
    (k) => `闲置${k}，几乎全新 可小刀`,
    (k) => `${k} 搬家清仓 同城自提`,
    (k) => `正品${k}，买来没怎么用`,
  ],
  pdd: [
    (k) => `${k} 大容量 官方旗舰正品`,
    (k) => `【百亿补贴】${k} 新款爆款`,
    (k) => `${k} 工厂直发 包邮到家`,
    (k) => `${k} 加厚升级款 限时秒杀`,
    (k) => `品牌${k} 万人团 好评如潮`,
  ],
};
const PRICE = {
  xianyu: [3900, 45000],
  pdd: [990, 12900],
  xhs: [1990, 39900],
  weibo: [0, 0],
};

export const topic = (appId, keyword) =>
  typeof keyword === "string" && keyword.trim() && keyword !== "演示关键词"
    ? keyword.trim()
    : FEED_TOPIC[appId] || "推荐";
// Search words demos use per platform, so screens read like real usage.
export const DEMO_KEYWORDS = {
  xhs: ["露营装备", "秋冬穿搭", "咖啡探店", "通勤包", "宠物用品", "平价护肤"],
  weibo: ["新能源汽车", "演唱会", "考研", "旅行攻略", "国产动画"],
  xianyu: ["二手相机", "机械键盘", "游戏手柄", "自行车"],
  pdd: ["充电宝", "运动鞋", "保温杯", "收纳盒", "蓝牙耳机", "四件套"],
};
export const demoKeyword = (appId, i) =>
  pick(DEMO_KEYWORDS[appId] || DEMO_KEYWORDS.xhs, i);
/** The n-th result title on a page of a platform for a keyword. */
export function simTitle(appId, keyword, page = 1, n = 1) {
  const k = topic(appId, keyword);
  const list = TITLES[appId] || TITLES.xhs;
  return pick(list, hash(`${appId}|${k}|${page}|${n}`))(k);
}
/** A plausible price in cents, stable for an item id. */
export function simPriceCents(appId, id) {
  const [lo, hi] = PRICE[appId] || PRICE.pdd;
  if (!hi) return 0;
  const raw = lo + (hash(`price|${id}`) % (hi - lo));
  // Prices end in 0 or 9, as shops write them.
  return Math.round(raw / 100) * 100 - (hash(id) % 2 ? 10 : 0);
}
/** Body text of a detail page (note, post, goods description, OCR). */
export function simDetailText(appId, target, keyword) {
  const k = topic(appId, keyword);
  const seed = hash(`${appId}|${target}|${k}`);
  return (
    {
      xhs: pick(
        [
          `姐妹们！${k}真的被我挖到宝了～做工和质感都在线，日常通勤完全够用。附上我的使用感受和搭配思路，建议收藏慢慢看。`,
          `今天来聊聊${k}。踩过坑也遇到过惊喜，总结了三点挑选经验：先看材质，再看尺码，最后看口碑。有问题评论区见～`,
        ],
        seed,
      ),
      weibo: `【${k}】据多方消息，相关话题今日讨论量持续上升。网友观点分化，有人点赞也有人质疑，你站哪一边？`,
      xianyu: `${k}，个人闲置，功能完好无拆修，配件齐全。诚心要的私聊，同城可面交。`,
      pdd: `${k}：精选材质，严格质检，7 天无理由退货，坏了包赔。已有上万人拼单，好评率 98%。`,
    }[appId] || `${k}：模拟详情内容。`
  );
}
