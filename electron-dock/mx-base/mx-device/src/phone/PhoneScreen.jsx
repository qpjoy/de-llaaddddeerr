// A simulated phone screen per platform (see screen-model.mjs for what is
// shown when). Sizes scale with the container, so the same screen serves a
// wall tile and the large workspace phone. Everything here is synthetic and
// the screen is watermarked as such.
import {
  Airplane,
  ArrowsClockwise,
  Barbell,
  BatteryCharging,
  BatteryHigh,
  Book,
  BowlFood,
  Camera,
  CaretLeft,
  Car,
  CellSignalFull,
  ChatCircle,
  Clock,
  Coffee,
  Couch,
  DeviceMobile,
  Diamond,
  DotsThree,
  Dress,
  GameController,
  Gear,
  Gift,
  Handbag,
  Headphones,
  Heart,
  House,
  Image,
  Laptop,
  Leaf,
  Lightning,
  Lock,
  MagnifyingGlass,
  MusicNote,
  PauseCircle,
  PawPrint,
  Plant,
  Plus,
  ShareFat,
  ShoppingCart,
  Sneaker,
  Sparkle,
  Star,
  TShirt,
  Tent,
  Timer,
  User,
  WarningCircle,
  Watch,
  WifiHigh,
  WifiSlash,
} from "@phosphor-icons/react";
import { APPS } from "./synth.mjs";
import "./phone.css";

const GLYPH = {
  Airplane,
  Barbell,
  BatteryCharging,
  Book,
  BowlFood,
  Camera,
  Car,
  Coffee,
  Couch,
  DeviceMobile,
  Diamond,
  Dress,
  GameController,
  Gift,
  Handbag,
  Headphones,
  Laptop,
  Leaf,
  Lightning,
  MusicNote,
  PawPrint,
  Plant,
  Sneaker,
  Sparkle,
  Star,
  TShirt,
  Tent,
  Watch,
};
const STATE_ICON = { WarningCircle, WifiSlash, Timer, PauseCircle, Lock };
const PENDING = {
  open: "打开应用",
  search: "搜索中",
  next: "加载下一页",
  list: "刷新列表",
  refresh: "下拉刷新",
  scroll: "滚动浏览",
  detail: "打开详情",
  ocr: "截图识别",
  like: "点赞",
  back: "返回",
  home: "回到桌面",
  restore: "恢复上下文",
};

function Thumb({ item, big = false }) {
  const Glyph = GLYPH[item.glyph] || Sparkle;
  const [from, to, ink] = item.palette;
  return (
    <span
      className={`ps-thumb${big ? " big" : ""}${item.tall ? " tall" : ""}`}
      style={{
        background: `linear-gradient(145deg, ${from}, ${to})`,
        color: ink,
      }}
    >
      <Glyph weight="duotone" />
    </span>
  );
}
function Avatar({ name }) {
  return <i className="ps-avatar">{name.slice(0, 1)}</i>;
}
function StatusBar({ m, light }) {
  return (
    <div className={`ps-status${light ? " light" : ""}`}>
      <span>{m.clock.time}</span>
      <span className="ps-status-icons">
        <CellSignalFull weight="fill" />
        <WifiHigh weight="bold" />
        <BatteryHigh weight="fill" />
        <small>{m.battery}</small>
      </span>
    </div>
  );
}
function SearchBar({ m, placeholder, typing, action }) {
  return (
    <div className="ps-searchrow">
      {m.view !== "feed" && <CaretLeft className="ps-back" weight="bold" />}
      <div className="ps-search">
        <MagnifyingGlass weight="bold" />
        {m.view === "feed" ? (
          <span className="ps-placeholder">{placeholder}</span>
        ) : (
          <span className={typing ? "ps-typing" : ""}>{m.keyword}</span>
        )}
      </div>
      {action && <b className="ps-search-action">{action}</b>}
    </div>
  );
}
function Tabs({ tabs, active = 0 }) {
  return (
    <div className="ps-tabs">
      {tabs.map((t, i) => (
        <span key={t} className={i === active ? "on" : ""}>
          {t}
        </span>
      ))}
    </div>
  );
}
function Loader({ text }) {
  return (
    <div className="ps-loader">
      <ArrowsClockwise className="ps-spin" weight="bold" />
      {text}
    </div>
  );
}
function Skeleton() {
  return (
    <div className="ps-skeleton">
      <i className="hero" />
      <i />
      <i />
      <i className="short" />
    </div>
  );
}
function BottomNav({ items }) {
  return (
    <div className="ps-nav">
      {items.map((x, i) =>
        x === "+" ? (
          <b key={i} className="ps-nav-plus">
            <Plus weight="bold" />
          </b>
        ) : (
          <span key={i} className={i === 0 ? "on" : ""}>
            {x}
          </span>
        ),
      )}
    </div>
  );
}
function SearchPage({ m, history, hot }) {
  return (
    <div className="ps-searchpage">
      <h5>历史记录</h5>
      <div className="ps-chips">
        {[...new Set([m.keyword, ...history])].slice(0, 4).map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
      <h5>{hot}</h5>
      <ol className="ps-hotlist">
        {m.items.slice(0, 4).map((item, i) => (
          <li key={item.id}>
            <b>{i + 1}</b>
            {item.title}
            {i < 2 && <em>热</em>}
          </li>
        ))}
      </ol>
      <Loader text="搜索中…" />
    </div>
  );
}
function Waterfall({ m, likes = true, price = false }) {
  return (
    <div className="ps-waterfall">
      {m.items.map((item) => (
        <article key={item.id} className="ps-card">
          <Thumb item={item} />
          <strong>{item.title}</strong>
          {price && (
            <span className="ps-price">
              ¥<b>{item.price}</b> <small>{item.want}人想要</small>
            </span>
          )}
          <footer>
            <Avatar name={item.author} />
            <span>{price ? "信用极好" : item.author}</span>
            {likes && (
              <em>
                <Heart /> {item.likes}
              </em>
            )}
          </footer>
        </article>
      ))}
    </div>
  );
}
function OcrSheet({ m }) {
  const lines = m.blocks.length
    ? m.blocks
    : (m.detail?.content || "")
        .split(/[。！？]/)
        .filter(Boolean)
        .slice(0, 3);
  return (
    <div className={`ps-ocr${m.scanning ? " scanning" : ""}`}>
      <i className="ps-scanline" />
      {!m.scanning && (
        <div className="ps-ocr-sheet">
          <b>识别到 {lines.length} 段文字</b>
          {lines.map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- 小红书 ----
function Xhs({ m }) {
  if (m.view === "detail" || m.view === "ocr") {
    if (m.loading) return <Skeleton />;
    const item = m.hero;
    const author = item.author;
    return (
      <div className="ps-detail">
        <div className="ps-author">
          <CaretLeft weight="bold" />
          <Avatar name={author} />
          <span>{author}</span>
          <b className="ps-follow">关注</b>
        </div>
        <Thumb big item={item} />
        <span className="ps-dots">
          <i className="on" />
          <i />
          <i />
        </span>
        <h4>{m.detail?.title}</h4>
        <p>{m.detail?.content}</p>
        <p className="ps-tags">#{m.keyword} #好物分享</p>
        <div className="ps-detail-bar">
          <span className="ps-input">说点什么…</span>
          <Heart /> {item.likes}
          <Star /> <ChatCircle />
        </div>
        {m.view === "ocr" && <OcrSheet m={m} />}
      </div>
    );
  }
  return (
    <>
      {m.view === "feed" ? (
        <div className="ps-header">
          <Tabs tabs={["关注", "发现", "附近"]} active={1} />
          <MagnifyingGlass weight="bold" />
        </div>
      ) : (
        <SearchBar
          m={m}
          typing={m.view === "search"}
          action={m.view === "search" ? "搜索" : null}
        />
      )}
      {m.view === "search" ? (
        <SearchPage
          m={m}
          history={["秋冬穿搭", "咖啡探店", "露营装备"]}
          hot="猜你想搜"
        />
      ) : (
        <>
          {m.view === "results" && (
            <Tabs tabs={["全部", "用户", "商品", "图片"]} />
          )}
          {m.refreshing && <Loader text="刷新中" />}
          <Waterfall m={m} />
          {m.loadingPage && <Loader text={`加载第 ${m.loadingPage} 页…`} />}
          {m.page > 1 && !m.loadingPage && (
            <span className="ps-pagechip">第 {m.page} 页</span>
          )}
        </>
      )}
      <BottomNav items={["首页", "购物", "+", "消息", "我"]} />
    </>
  );
}

// ---- 微博 ----
function WeiboCard({ item, liked, liking }) {
  return (
    <article className="ps-post">
      <header>
        <Avatar name={item.author} />
        <div>
          <b>{item.author}</b>
          <small>{item.when} · 来自 模拟器</small>
        </div>
        <DotsThree weight="bold" />
      </header>
      <p>{item.title}</p>
      <div className="ps-imgrow">
        <Thumb item={item} />
        <Thumb
          item={{
            ...item,
            palette: [item.palette[1], item.palette[0], item.palette[2]],
          }}
        />
        <Thumb item={{ ...item, glyph: "Camera" }} />
      </div>
      <footer>
        <span>
          <ShareFat /> {item.shares}
        </span>
        <span>
          <ChatCircle /> {item.comments}
        </span>
        <span className={`${liked ? "liked" : ""}${liking ? " liking" : ""}`}>
          <Heart weight={liked ? "fill" : "regular"} />{" "}
          {liked ? "已赞" : item.likes}
        </span>
      </footer>
    </article>
  );
}
function Weibo({ m }) {
  if (m.view === "detail" || m.view === "ocr") {
    if (m.loading) return <Skeleton />;
    const item = m.hero;
    return (
      <div className="ps-detail">
        <div className="ps-author">
          <CaretLeft weight="bold" />
          <span>微博正文</span>
        </div>
        <WeiboCard item={{ ...item, title: m.detail?.content || item.title }} />
        {m.view === "ocr" && <OcrSheet m={m} />}
      </div>
    );
  }
  return (
    <>
      {m.view === "feed" || m.view === "post" ? (
        <div className="ps-header">
          <Tabs tabs={["关注", "推荐", "热门"]} active={1} />
          <MagnifyingGlass weight="bold" />
        </div>
      ) : (
        <SearchBar
          m={m}
          typing={m.view === "search"}
          action={m.view === "search" ? "搜索" : null}
        />
      )}
      {m.view === "search" ? (
        <SearchPage
          m={m}
          history={["新能源汽车", "演唱会", "考研"]}
          hot="微博热搜"
        />
      ) : (
        <div className="ps-feed">
          {m.view === "results" && (
            <Tabs tabs={["综合", "实时", "用户", "视频"]} />
          )}
          {m.refreshing && <Loader text="刷新中" />}
          {(m.view === "post" ? [m.hero] : m.items).map((item, i) => (
            <WeiboCard
              key={item.id}
              item={item}
              liked={m.view === "post" && i === 0 && m.liked}
              liking={m.view === "post" && i === 0 && m.liking}
            />
          ))}
          {m.loadingPage && <Loader text={`加载第 ${m.loadingPage} 页…`} />}
        </div>
      )}
      <BottomNav items={["首页", "视频", "发现", "消息", "我"]} />
    </>
  );
}

// ---- 闲鱼 ----
function Xianyu({ m }) {
  if (m.view === "detail" || m.view === "ocr") {
    if (m.loading) return <Skeleton />;
    const item = m.hero;
    return (
      <div className="ps-detail">
        <div className="ps-author">
          <CaretLeft weight="bold" />
          <Avatar name={item.author} />
          <span>{item.author}</span>
          <small>信用极好</small>
        </div>
        <span className="ps-price big">
          ¥<b>{item.price}</b>
        </span>
        <h4>{m.detail?.title}</h4>
        <p>{m.detail?.content}</p>
        <Thumb big item={item} />
        <div className="ps-buy">
          <span>聊一聊</span>
          <b className="yellow">我想要</b>
        </div>
        {m.view === "ocr" && <OcrSheet m={m} />}
      </div>
    );
  }
  return (
    <>
      <div className="ps-brandhead">
        <SearchBar
          m={m}
          placeholder="搜索闲置好物"
          typing={m.view === "search"}
          action={m.view === "search" ? "搜索" : null}
        />
        {m.view === "feed" && <Tabs tabs={["推荐", "附近", "数码", "服饰"]} />}
      </div>
      {m.view === "search" ? (
        <SearchPage
          m={m}
          history={["二手相机", "机械键盘", "露营装备"]}
          hot="大家都在搜"
        />
      ) : (
        <>
          {m.refreshing && <Loader text="下拉刷新中" />}
          <Waterfall m={m} likes={false} price />
          {m.loadingPage && <Loader text={`加载第 ${m.loadingPage} 页…`} />}
        </>
      )}
      <BottomNav items={["闲鱼", "会玩", "+", "消息", "我的"]} />
    </>
  );
}

// ---- 拼多多 ----
function PddRow({ item }) {
  return (
    <article className="ps-goods">
      <Thumb item={item} />
      <div>
        <strong>{item.title}</strong>
        <em className="ps-tag">百亿补贴</em>
        <span className="ps-price">
          ¥<b>{item.price}</b> <small>已拼{item.sold}件</small>
        </span>
      </div>
      <b className="ps-pin">去拼单</b>
    </article>
  );
}
function Pdd({ m }) {
  if (m.view === "detail" || m.view === "ocr") {
    if (m.loading) return <Skeleton />;
    const item = m.hero;
    const price = item.price;
    return (
      <div className="ps-detail">
        <Thumb big item={item} />
        <div className="ps-pricebar">
          <span>
            ¥<b>{price}</b> 券后价
          </span>
          <small>已拼 {item.sold} 件</small>
        </div>
        <h4>{m.detail?.title}</h4>
        <p className="ps-tags">7 天无理由 · 极速退款 · 坏了包赔</p>
        <p>{m.detail?.content}</p>
        <div className="ps-buy">
          <span>单独购买</span>
          <b className="red">发起拼单 ¥{price}</b>
        </div>
        {m.view === "ocr" && <OcrSheet m={m} />}
      </div>
    );
  }
  return (
    <>
      <div className="ps-brandhead">
        <SearchBar
          m={m}
          placeholder="搜索商品"
          typing={m.view === "search"}
          action={m.view === "search" ? "搜索" : null}
        />
        {m.view === "feed" && (
          <Tabs tabs={["推荐", "百亿补贴", "手机", "女装"]} />
        )}
        {m.view === "results" && (
          <Tabs tabs={["综合", "销量", "价格", "品牌"]} />
        )}
      </div>
      {m.view === "search" ? (
        <SearchPage
          m={m}
          history={["充电宝", "保温杯", "运动鞋"]}
          hot="热门搜索"
        />
      ) : (
        <div className={`ps-list${m.scrolling ? " scrolling" : ""}`}>
          {m.view === "feed" && (
            <div className="ps-banner">百亿补贴 · 正品保障</div>
          )}
          {m.refreshing && <Loader text="下拉刷新中" />}
          {m.items.map((item) => (
            <PddRow key={item.id} item={item} />
          ))}
          {m.loadingPage && <Loader text={`加载第 ${m.loadingPage} 页…`} />}
        </div>
      )}
      <BottomNav items={["首页", "多多视频", "分类", "聊天", "个人中心"]} />
    </>
  );
}
const APP_VIEWS = { xhs: Xhs, weibo: Weibo, xianyu: Xianyu, pdd: Pdd };

function AppIcon({ appId, label = true }) {
  const app = APPS[appId];
  return (
    <span className="ps-appicon">
      <i style={{ background: app?.bg || "#5f7a8f", color: app?.fg || "#fff" }}>
        {app?.mark || appId}
      </i>
      {label && <small>{app?.name || appId}</small>}
    </span>
  );
}
function Home({ m }) {
  return (
    <div className="ps-home">
      <div className="ps-widget">
        <b>{m.clock.time}</b>
        <small>{m.clock.date}</small>
      </div>
      <div className="ps-grid">
        {m.apps.map((id) => (
          <AppIcon key={id} appId={id} />
        ))}
        {[
          ["相机", Camera],
          ["相册", Image],
          ["时钟", Clock],
          ["设置", Gear],
        ].map(([name, Icon]) => (
          <span className="ps-appicon" key={name}>
            <i className="system">
              <Icon weight="fill" />
            </i>
            <small>{name}</small>
          </span>
        ))}
      </div>
      <div className="ps-dock">
        <i className="system">
          <House weight="fill" />
        </i>
        <i className="system">
          <ChatCircle weight="fill" />
        </i>
        <i className="system">
          <ShoppingCart weight="fill" />
        </i>
        <i className="system">
          <User weight="fill" />
        </i>
      </div>
    </div>
  );
}
function LockScreen({ m }) {
  return (
    <div className="ps-lock">
      <Lock weight="fill" />
      <b>{m.clock.time}</b>
      <small>{m.clock.date}</small>
      <span>上滑解锁</span>
    </div>
  );
}
function Splash({ m }) {
  const app = APPS[m.appId];
  return (
    <div className="ps-splash" style={{ background: app?.bg, color: app?.fg }}>
      <AppIcon appId={m.appId} label={false} />
      <b>{app?.name}</b>
      <span className="ps-dotsload">
        <i />
        <i />
        <i />
      </span>
    </div>
  );
}

export default function PhoneScreen({ model: m, tile = true }) {
  const App = APP_VIEWS[m.appId] || Xhs;
  const light =
    ["lock", "home", "splash"].includes(m.surface) &&
    !(m.surface === "splash" && m.appId === "xianyu");
  const State = m.overlay && STATE_ICON[m.overlay.icon];
  return (
    <div
      className={`ps ps-${m.appId} ${tile ? "ps-tile" : "ps-large"} ps-on-${m.surface} ps-view-${m.view}`}
      aria-label={`${m.synthetic ? "模拟" : ""}手机画面：${APPS[m.appId]?.name || ""}`}
    >
      <StatusBar
        m={m}
        light={
          light ||
          (m.appId === "pdd" &&
            m.surface === "app" &&
            !["detail", "ocr"].includes(m.view))
        }
      />
      <div className={`ps-body${m.overlay?.dim ? " dim" : ""}`}>
        {m.surface === "lock" ? (
          <LockScreen m={m} />
        ) : m.surface === "home" ? (
          <Home m={m} />
        ) : m.surface === "splash" ? (
          <Splash m={m} />
        ) : (
          <App m={m} />
        )}
      </div>
      {m.toast && <div className="ps-toast">{m.toast}</div>}
      {m.pending && !m.overlay && (
        <div className="ps-op">
          <i />
          {PENDING[m.pending.action] || m.pending.name}
          {m.pending.page ? ` · 第 ${m.pending.page} 页` : ""}
        </div>
      )}
      {m.parked && !m.pending && !m.overlay && (
        <div className="ps-op parked">检查点等待</div>
      )}
      {m.overlay && (
        <div className={`ps-overlay ${m.overlay.tone || ""}`}>
          <span>
            {State && <State weight="fill" />}
            <b>{m.overlay.title}</b>
            <small>{m.overlay.note}</small>
          </span>
        </div>
      )}
      {m.synthetic ? (
        <span className="ps-watermark">模拟</span>
      ) : m.source === "poc" ? (
        <span className="ps-watermark poc">PoC</span>
      ) : null}
    </div>
  );
}
