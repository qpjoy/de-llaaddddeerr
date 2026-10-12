import { useState } from "react";
import { ChevronDown, ChevronUp, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipLocation } from "./ip-location";
import { IpRegionMap } from "./ip-region-map";

export function IpLocationMap({ profile }: { profile: any }) {
  const location = ipLocation(profile), [opened, setOpened] = useState(true);
  return <section className="harbor-location" aria-label="IP 地理位置">
    <div className="harbor-location-heading"><h3><MapPin aria-hidden="true" />IP 地理位置</h3>
      {location?.embed && <Button variant="ghost" size="sm" aria-label={opened ? "收起地图" : "展开地图"} aria-expanded={opened} onClick={() => setOpened(v => !v)}>{opened ? "收起" : "展开"}{opened ? <ChevronUp data-icon="inline-end" /> : <ChevronDown data-icon="inline-end" />}</Button>}
    </div>
    {location ? <>
      {location.embed && <div className="harbor-map-surface" hidden={!opened}>
        <IpRegionMap key={location.embed} location={location} visible={opened}/>
        <p className="harbor-map-credit">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a></p>
      </div>}
      <p className="harbor-location-note">{location.embed ? "区域参考 · 非实时定位" : "该位置暂不支持地图展示。"}</p>
    </> : <p className="harbor-hint">本次画像未提供有效经纬度，暂无法在地图上展示。</p>}
  </section>;
}
