import { useState } from "react";
import { ChevronDown, ChevronUp, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipLocation } from "./ip-location";
import { IpRegionMap } from "./ip-region-map";

export function IpLocationMap({ profile }: { profile: any }) {
  const location = ipLocation(profile), [opened, setOpened] = useState(true);
  const place = [profile.country, profile.province, profile.city, profile.district].filter(Boolean).join(" · ");
  return <section className="harbor-location" aria-label="IP 地理位置">
    <div className="harbor-location-heading"><h3><MapPin aria-hidden="true" />IP 地理位置</h3>
      {location?.embed && <Button variant="ghost" size="sm" aria-label={opened ? "收起地图" : "展开地图"} aria-expanded={opened} onClick={() => setOpened(v => !v)}>{opened ? "收起" : "展开"}{opened ? <ChevronUp data-icon="inline-end" /> : <ChevronDown data-icon="inline-end" />}</Button>}
    </div>
    {location ? <>
      {location.embed && <div className="harbor-map-surface" hidden={!opened}>
        <IpRegionMap key={location.embed} location={location} visible={opened}/>
        <p className="harbor-map-credit">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a></p>
      </div>}
      {!location.embed && <p className="harbor-location-note">该坐标的坐标系或纬度范围暂不支持地图展示。</p>}
      <details className="harbor-location-details">
        <summary aria-label="坐标与地图说明">{location.embed && <span className="harbor-location-disclaimer">区域参考 · 非实时定位</span>}<span className="harbor-location-disclosure">坐标说明<ChevronDown aria-hidden="true" /></span></summary>
        <p>{place || "未提供归属地"}</p>
        <p>经度 {location.lng} · 纬度 {location.lat} · {location.crs || "坐标系未标注"}</p>
        {location.embed && <>
          <p>{location.wgs84 ? "地图标记来自本次画像坐标。" : "地图按原始坐标展示大致区域，不作精确定位。"}加载地图不消耗查询次数。</p>
          <p>IP 归属位置不能代表使用者的实时位置。</p>
          <p>按需加载当前区域，不发送查询 IP 或账号信息。</p>
        </>}
      </details>
    </> : <p className="harbor-hint">本次画像未提供有效经纬度，暂无法在地图上展示。</p>}
  </section>;
}
