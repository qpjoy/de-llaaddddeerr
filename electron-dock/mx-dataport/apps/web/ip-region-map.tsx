import { useEffect, useRef, useState } from "react";
import type { Map as LeafletMap } from "leaflet";
import "leaflet/dist/leaflet.css";
import { Button } from "@/components/ui/button";
import type { ipLocation } from "./ip-location";

type Location = NonNullable<ReturnType<typeof ipLocation>>;
type MapStatus = "loading" | "ready" | "slow" | "error";

// Render the delivered portrait's region automatically. No geocoder, IP query or remote JS.
export function IpRegionMap({ location, visible }: { location: Location; visible: boolean }) {
  const container = useRef<HTMLDivElement>(null), mapRef = useRef<LeafletMap | null>(null);
  const [status, setStatus] = useState<MapStatus>("loading"), [attempt, setAttempt] = useState(0);
  const { lng, lat, wgs84 } = location;
  const [west, south, east, north] = location.bounds;

  useEffect(() => {
    let disposed = false, map: LeafletMap | undefined, observer: ResizeObserver | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const failures = new Set<HTMLElement>();
    const loading = () => {
      if (disposed) return;
      clearTimeout(timer);
      setStatus("loading");
      timer = setTimeout(() => { if (!disposed) setStatus("slow"); }, 8000);
    };
    loading();
    import("leaflet").then(L => {
      if (disposed || !container.current) return;
      const show = () => {
        if (disposed || !container.current?.clientWidth) return;
        if (map) { map.invalidateSize({ pan: false }); return; }
        map = L.map(container.current, {
          attributionControl: false, zoomControl: false, scrollWheelZoom: false,
          minZoom: 2, maxZoom: wgs84 ? 16 : 9,
        }).fitBounds([[south, west], [north, east]], { animate: false });
        mapRef.current = map;
        L.control.zoom({ position: "topright", zoomInTitle: "放大地图", zoomOutTitle: "缩小地图" }).addTo(map);
        // Only visible tiles, normal browser caching, origin-only Referer per OSM policy.
        const tiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19, keepBuffer: 0, updateWhenIdle: true, referrerPolicy: "origin",
        });
        tiles.on("loading", loading);
        tiles.on("tileerror", event => {
          failures.add(event.tile);
          if (!disposed) setStatus("error");
        });
        tiles.on("tileunload", event => failures.delete(event.tile));
        tiles.on("load", () => {
          clearTimeout(timer);
          if (!disposed) setStatus(failures.size ? "error" : "ready");
        });
        tiles.addTo(map);
        if (wgs84) L.circleMarker([lat, lng], {
          radius: 7, color: "#165dff", fillColor: "#165dff", fillOpacity: .5, weight: 2,
        }).bindTooltip("画像返回位置").addTo(map);
      };
      show();
      observer = new ResizeObserver(show);
      observer.observe(container.current);
    }).catch(() => {
      clearTimeout(timer);
      if (!disposed) setStatus("error");
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
      observer?.disconnect();
      map?.remove();
      mapRef.current = null;
    };
  }, [lng, lat, wgs84, west, south, east, north, attempt]);

  useEffect(() => {
    if (visible) mapRef.current?.invalidateSize({ pan: false });
  }, [visible]);

  return <div className="harbor-map-frame">
    <div ref={container} className="harbor-location-map" aria-label="IP 归属区域地图" role="region"/>
    {status !== "ready" && <div className="harbor-map-status">
      <p role="status">{status === "loading" ? "正在加载地图…" : status === "slow" ? "底图加载较慢，可稍后重试；画像结果已保留。" : "部分或全部底图加载失败，可重试；画像结果已保留。"}</p>
      {status !== "loading" && <div className="harbor-map-actions"><Button variant="outline" onClick={() => setAttempt(value => value + 1)}>重试地图</Button><a href={location.embed!} target="_blank" rel="noreferrer">在 OpenStreetMap 打开</a></div>}
    </div>}
  </div>;
}
