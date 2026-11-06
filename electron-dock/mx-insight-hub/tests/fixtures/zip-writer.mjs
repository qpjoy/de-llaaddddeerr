// Minimal ZIP writer for tests: stored / deflate entries, optional ZIP64
// records, and knobs to fake encryption or another compression method.
import zlib from 'node:zlib'

const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16LE(value); return b }
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b }
const u64 = value => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b }

/**
 * entries: [{ name, data, method = 8, encrypted = false, declaredMethod, declaredSize, crc }]
 * options: { zip64 = false }
 */
export function buildZip(entries, { zip64 = false } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const method = entry.method ?? 8
    const body = method === 8 ? zlib.deflateRawSync(data) : data
    const crc = entry.crc ?? zlib.crc32(data)
    const size = entry.declaredSize ?? data.length
    const name = Buffer.from(entry.name)
    const flags = 0x0800 | (entry.encrypted ? 1 : 0)
    const declaredMethod = entry.declaredMethod ?? method
    const localExtra = zip64 ? Buffer.concat([u16(1), u16(16), u64(size), u64(body.length)]) : Buffer.alloc(0)
    const local = Buffer.concat([
      u32(0x04034b50), u16(zip64 ? 45 : 20), u16(flags), u16(declaredMethod), u16(0), u16(0), u32(crc),
      u32(zip64 ? 0xffffffff : body.length), u32(zip64 ? 0xffffffff : size), u16(name.length), u16(localExtra.length), name, localExtra, body,
    ])
    const centralExtra = zip64 ? Buffer.concat([u16(1), u16(24), u64(size), u64(body.length), u64(offset)]) : Buffer.alloc(0)
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(45), u16(zip64 ? 45 : 20), u16(flags), u16(declaredMethod), u16(0), u16(0), u32(crc),
      u32(zip64 ? 0xffffffff : body.length), u32(zip64 ? 0xffffffff : size), u16(name.length), u16(centralExtra.length), u16(0),
      u16(0), u16(0), u32(0), u32(zip64 ? 0xffffffff : offset), name, centralExtra,
    ]))
    locals.push(local)
    offset += local.length
  }
  const directory = Buffer.concat(centrals)
  const tail = []
  if (zip64) {
    const recordOffset = offset + directory.length
    tail.push(Buffer.concat([
      u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0),
      u64(entries.length), u64(entries.length), u64(directory.length), u64(offset),
    ]), Buffer.concat([u32(0x07064b50), u32(0), u64(recordOffset), u32(1)]))
  }
  tail.push(Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(zip64 ? 0xffff : entries.length), u16(zip64 ? 0xffff : entries.length),
    u32(zip64 ? 0xffffffff : directory.length), u32(zip64 ? 0xffffffff : offset), u16(0),
  ]))
  return Buffer.concat([...locals, directory, ...tail])
}
