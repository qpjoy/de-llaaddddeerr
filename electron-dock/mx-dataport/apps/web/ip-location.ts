// No geocoder or acquisition: only coordinates already present in this portrait.
export function ipLocation(profile: { longitude?: unknown; latitude?: unknown; coordinate_system?: unknown } | null) {
  const lng = profile?.longitude, lat = profile?.latitude;
  if (typeof lng !== "number" || typeof lat !== "number" || !Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
  const crs = typeof profile?.coordinate_system === "string" ? profile.coordinate_system.toUpperCase() : null;
  const wgs84 = crs === "WGS84" || crs === "EPSG:4326";
  // Unknown coordinates are shown as a broad region, never an exact map pin.
  // Explicit incompatible coordinate systems must be transformed by an authoritative adapter first.
  const supported = (!crs || wgs84) && Math.abs(lat) <= 85;
  const span = wgs84 ? .15 : 1;
  const bounds = [Math.max(-180, lng - span), Math.max(-85, lat - span), Math.min(180, lng + span), Math.min(85, lat + span)];
  const url = new URL("https://www.openstreetmap.org/export/embed.html");
  url.searchParams.set("bbox", bounds.join(","));
  url.searchParams.set("layer", "mapnik");
  if (wgs84) url.searchParams.set("marker", `${lat},${lng}`);
  return { lng, lat, crs, wgs84, bounds, embed: supported ? url.href : null };
}
