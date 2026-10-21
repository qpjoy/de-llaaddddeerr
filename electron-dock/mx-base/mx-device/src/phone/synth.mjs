// Display-only details for simulated phone screens: authors, likes, prices,
// thumbnails and the status bar, derived deterministically from ids so a
// screen looks the same on every render and every viewer. Never real data.
import {
  FEED_TOPIC,
  hash,
  pick,
  simPriceCents,
  simTitle,
  topic,
} from "../../server/sim-content.mjs";

export { FEED_TOPIC, topic };

// Brand-like colors (generic marks, not the platforms' logos).
export const APPS = {
  xhs: { name: "小红书", mark: "小红书", bg: "#ff2442", fg: "#fff" },
  weibo: { name: "微博", mark: "微博", bg: "#ff8200", fg: "#fff" },
  xianyu: { name: "闲鱼", mark: "闲鱼", bg: "#ffe60f", fg: "#33280a" },
  pdd: { name: "拼多多", mark: "拼", bg: "#e02e24", fg: "#fff" },
};
const AUTHORS = [
  "一只小熊",
  "阿杰爱数码",
  "露营小白",
  "周末去哪儿",
  "橘子汽水",
  "林间有风",
  "可乐不加冰",
  "晚风与你",
  "芝士就是力量",
  "山野日记",
  "小鹿乱撞",
  "今天也要早睡",
];
// Thumbnail glyph by what the keyword is about; names of Phosphor icons.
const GLYPHS = [
  [/鞋|跑步|球鞋/, "Sneaker"],
  [/耳机|音乐/, "Headphones"],
  [/充电|电源|电池/, "BatteryCharging"],
  [/裙/, "Dress"],
  [/衣|穿搭|T恤|外套|卫衣/, "TShirt"],
  [/咖啡|奶茶|探店|杯/, "Coffee"],
  [/相机|摄影|拍照/, "Camera"],
  [/包|箱/, "Handbag"],
  [/露营|帐篷|户外/, "Tent"],
  [/猫|狗|宠物/, "PawPrint"],
  [/书|阅读/, "Book"],
  [/游戏|手柄/, "GameController"],
  [/电脑|笔记本|键盘/, "Laptop"],
  [/手机|数码/, "DeviceMobile"],
  [/手表/, "Watch"],
  [/美食|餐|零食/, "BowlFood"],
  [/旅行|机票|酒店/, "Airplane"],
  [/汽车|新能源/, "Car"],
  [/家居|沙发|收纳/, "Couch"],
  [/健身|减脂/, "Barbell"],
  [/花|植物/, "Plant"],
  [/演唱会|明星/, "MusicNote"],
];
const FALLBACK_GLYPHS = [
  "Sparkle",
  "Gift",
  "Star",
  "Leaf",
  "Lightning",
  "Diamond",
];
// Soft photo-like backgrounds: [from, to, ink].
const PALETTES = [
  ["#fde2e4", "#fbc4ca", "#b4233c"],
  ["#e2ecfd", "#c4d7fb", "#2853a8"],
  ["#e3f6ee", "#bfe9d6", "#1f7a55"],
  ["#fff1d6", "#ffdca1", "#9a5b00"],
  ["#efe5fd", "#d9c6fa", "#5b33a8"],
  ["#e0f4f7", "#b7e3ea", "#16727f"],
  ["#f7e8de", "#efcdb6", "#8a4a22"],
  ["#eceff3", "#d5dbe3", "#3e4c5e"],
];

export function glyphFor(keyword, seed) {
  const k = String(keyword || "");
  return GLYPHS.find(([re]) => re.test(k))?.[1] || pick(FALLBACK_GLYPHS, seed);
}
export const palette = (seed) => pick(PALETTES, seed);
export function count(n) {
  return n >= 10000
    ? `${(n / 10000).toFixed(1).replace(/\.0$/, "")}万`
    : `${n}`;
}
export const yuan = (cents) => {
  const v = cents / 100;
  return Number.isInteger(v) ? `${v}` : v.toFixed(2).replace(/0$/, "");
};

/** A result row with everything a screen draws. */
export function enrich(appId, keyword, item, index = 0) {
  const seed = hash(`${appId}|${item.id}`);
  const cents = Number.isSafeInteger(item.priceCents)
    ? item.priceCents
    : simPriceCents(appId, item.id);
  return {
    id: item.id,
    title: item.title || simTitle(appId, keyword, 1, index + 1),
    author: item.authorName || pick(AUTHORS, seed >>> 3),
    likes: count((seed % 48000) + 120),
    comments: count((seed >>> 7) % 900),
    shares: count((seed >>> 11) % 400),
    price: yuan(cents),
    sold: `${((seed >>> 5) % 98) + 2}万+`,
    want: (seed >>> 9) % 300,
    when: pick(["刚刚", "3分钟前", "12分钟前", "1小时前", "昨天"], seed >>> 13),
    tall: seed % 3 === 0, // waterfall card height
    glyph: glyphFor(keyword, seed),
    palette: palette(seed >>> 2),
  };
}
/** The platform's own feed when no receipt listed anything yet. */
export function feed(appId, seedText, n = 6) {
  const k = FEED_TOPIC[appId];
  return Array.from({ length: n }, (_, i) =>
    enrich(
      appId,
      k,
      {
        id: `${seedText}|feed|${appId}|${i}`,
        title: simTitle(appId, k, 1, i + 1),
      },
      i,
    ),
  );
}

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
export function clock(now) {
  const d = new Date(now);
  return {
    time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
    date: `${d.getMonth() + 1}月${d.getDate()}日 星期${WEEK[d.getDay()]}`,
  };
}
export const battery = (deviceId) => 38 + (hash(`battery|${deviceId}`) % 60);
