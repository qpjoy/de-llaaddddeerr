import { useState } from "react";
import { MapPin, Map } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipLocation } from "./ip-location";
import { IpRegionMap } from "./ip-region-map";

export function IpLocationMap({ profile }: { profile: any }) {
  const location = ipLocation(profile), [opened, setOpened] = useState(true);
  const place = [profile.country, profile.province, profile.city, profile.district].filter(Boolean).join(" · ");
  return <section className="harbor-location" aria-label="IP 地理位置">
    <div className="harbor-location-heading"><div><h3><MapPin size={18} />IP 地理位置</h3><p>{place || "未提供归属地"}</p></div>
      {location?.embed && <Button variant="outline" aria-expanded={opened} onClick={() => setOpened(v => !v)}><Map size={16} />{opened ? "收起地图" : "展开地图"}</Button>}
    </div>
    {location ? <><p className="harbor-hint">经度 {location.lng} · 纬度 {location.lat} · {location.crs || "坐标系未标注"}</p>
      {location.embed && <div hidden={!opened}><IpRegionMap key={location.embed} location={location} visible={opened}/></div>}
      <p className="harbor-hint">{!location.embed ? "该坐标的坐标系或纬度范围暂不支持地图展示。" : location.wgs84 ? "地图标记来自本次画像坐标。" : "地图按原始坐标展示大致区域，不作精确定位。"}IP 归属位置不能代表使用者的实时位置。加载地图不消耗查询次数。</p>
      {location.embed && <p className="harbor-map-credit">底图 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a> · 按需加载当前区域，不发送查询 IP 或账号信息。</p>}
    </> : <p className="harbor-hint">本次画像未提供有效经纬度，暂无法在地图上展示。</p>}
  </section>;
}
