// Signature checks for every type this service is willing to store. Active
// content (HTML/SVG/scripts) has no entry here and is therefore rejected.
const fail = (status, code) => Object.assign(new Error(code), { status, code })
const ascii = (body, start, end) => body.toString('ascii', start, end)

const SIGNATURES = {
  'image/jpeg': body => body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff,
  'image/png': body => body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': body => ascii(body, 0, 4) === 'RIFF' && ascii(body, 8, 12) === 'WEBP',
  'video/mp4': body => ascii(body, 4, 8) === 'ftyp',
  'video/webm': body => body.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
  'audio/mpeg': body => ascii(body, 0, 3) === 'ID3' || (body[0] === 255 && (body[1] & 224) === 224),
  'audio/ogg': body => ascii(body, 0, 4) === 'OggS',
  'audio/wav': body => ascii(body, 0, 4) === 'RIFF' && ascii(body, 8, 12) === 'WAVE',
  'application/pdf': body => ascii(body, 0, 5) === '%PDF-',
}
// Every signature above is decided within the first 12 bytes, so a streaming
// download can reject a bad source before writing the rest of it to disk.
export const SIGNATURE_BYTES = 12
export const TYPES = new Set(Object.keys(SIGNATURES))

export function validateMedia(body, type) {
  const check = SIGNATURES[type]
  if (!check) throw fail(415, 'media_content_invalid')
  if (body.length < SIGNATURE_BYTES || !check(body)) throw fail(415, 'media_content_invalid')
}
