import { mobileOrigin, serialNumber } from "./model.mjs";

export const MAX_FRAME_BYTES = 6 * 1024 * 1024;

// Intentionally no arbitrary proxy, action, restart, stop, config or video endpoints.
export async function captureMobile(device, fetchImpl = fetch) {
  if (device.mode !== "real" || !device.observer)
    throw Error("Real observer required");
  const url = new URL("/api/screen.png", mobileOrigin(device.observer.origin));
  url.searchParams.set("device", serialNumber(device.observer.serial));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "image/png" },
    });
    if (
      response.status !== 200 ||
      response.headers.get("content-type")?.split(";")[0] !== "image/png"
    )
      throw Error("Invalid screenshot response");
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_FRAME_BYTES) throw Error("Screenshot too large");
      chunks.push(chunk);
    }
    const png = Buffer.concat(chunks);
    if (
      png.length < 33 ||
      !png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
      png.toString("ascii", 12, 16) !== "IHDR"
    )
      throw Error("Invalid PNG");
    const width = png.readUInt32BE(16),
      height = png.readUInt32BE(20);
    if (
      !width ||
      !height ||
      width > 8192 ||
      height > 8192 ||
      width * height > 16000000
    )
      throw Error("Invalid screenshot dimensions");
    return { png, width, height };
  } finally {
    controller.abort();
    clearTimeout(timer);
  }
}
