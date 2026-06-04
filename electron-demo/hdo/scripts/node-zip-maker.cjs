const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { MakerBase } = require('@electron-forge/maker-base');

const UTF8_FLAG = 0x0800;
const STORE = 0;
const DEFLATE = 8;

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  return {
    date: ((year - 1980) << 9) | (month << 5) | day,
    time: (hours << 11) | (minutes << 5) | seconds
  };
}

function writeUInt16(value) {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value, 0);
  return buffer;
}

function writeUInt32(value) {
  if (value > 0xffffffff) {
    throw new Error('ZIP64 is not supported by the local node zip maker');
  }
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0, 0);
  return buffer;
}

function writeAll(stream, buffer) {
  return new Promise((resolve, reject) => {
    stream.write(buffer, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function closeWriteStream(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('finish', onFinish);
      stream.off('error', onError);
    };
    const onFinish = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };

    stream.once('finish', onFinish);
    stream.once('error', onError);
    stream.end();
  });
}

async function collectEntries(rootDir, rootName) {
  const entries = [];

  async function walk(absPath, relPath) {
    const stat = await fs.stat(absPath);
    const normalizedRelPath = relPath.split(path.sep).join('/');

    if (stat.isDirectory()) {
      entries.push({
        absPath,
        relPath: normalizedRelPath.endsWith('/') ? normalizedRelPath : `${normalizedRelPath}/`,
        stat,
        type: 'directory'
      });

      const names = (await fs.readdir(absPath)).sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        await walk(path.join(absPath, name), path.join(relPath, name));
      }
      return;
    }

    if (stat.isFile()) {
      entries.push({
        absPath,
        relPath: normalizedRelPath,
        stat,
        type: 'file'
      });
    }
  }

  await walk(rootDir, rootName);
  return entries;
}

function createLocalHeader(entry) {
  const nameBuffer = Buffer.from(entry.relPath, 'utf8');
  const { date, time } = toDosDateTime(entry.stat.mtime);
  const header = Buffer.allocUnsafe(30);

  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressedSize, 18);
  header.writeUInt32LE(entry.uncompressedSize, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);

  return Buffer.concat([header, nameBuffer]);
}

function createCentralHeader(entry) {
  const nameBuffer = Buffer.from(entry.relPath, 'utf8');
  const { date, time } = toDosDateTime(entry.stat.mtime);
  const header = Buffer.allocUnsafe(46);

  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.uncompressedSize, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(entry.type === 'directory' ? 0x10 : 0, 38);
  header.writeUInt32LE(entry.offset, 42);

  return Buffer.concat([header, nameBuffer]);
}

async function createZipFromDirectory(sourceDir, zipPath) {
  const rootName = path.basename(sourceDir);
  const entries = await collectEntries(sourceDir, rootName);

  await fs.rm(zipPath, { force: true });
  await fs.mkdir(path.dirname(zipPath), { recursive: true });

  const stream = createWriteStream(zipPath);
  const centralHeaders = [];
  let offset = 0;

  try {
    for (const entry of entries) {
      let payload = Buffer.alloc(0);
      let crc = 0;
      let method = STORE;
      let uncompressedSize = 0;

      if (entry.type === 'file') {
        const fileBuffer = await fs.readFile(entry.absPath);
        const deflated = zlib.deflateRawSync(fileBuffer, { level: 9 });
        payload = deflated.length < fileBuffer.length ? deflated : fileBuffer;
        method = payload === deflated ? DEFLATE : STORE;
        crc = crc32(fileBuffer);
        uncompressedSize = fileBuffer.length;
      }

      Object.assign(entry, {
        crc,
        method,
        uncompressedSize,
        compressedSize: payload.length,
        offset
      });

      const localHeader = createLocalHeader(entry);
      await writeAll(stream, localHeader);
      await writeAll(stream, payload);
      centralHeaders.push(createCentralHeader(entry));
      offset += localHeader.length + payload.length;
    }

    const centralOffset = offset;
    for (const header of centralHeaders) {
      await writeAll(stream, header);
      offset += header.length;
    }

    const end = Buffer.concat([
      writeUInt32(0x06054b50),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(centralHeaders.length),
      writeUInt16(centralHeaders.length),
      writeUInt32(offset - centralOffset),
      writeUInt32(centralOffset),
      writeUInt16(0)
    ]);
    await writeAll(stream, end);
  } finally {
    await closeWriteStream(stream);
  }
}

class NodeZipMaker extends MakerBase {
  constructor(config, platforms) {
    super(config, platforms || ['win32']);
    this.name = 'node-zip';
    this.defaultPlatforms = ['win32'];
  }

  isSupportedOnCurrentPlatform() {
    return true;
  }

  async make({ dir, makeDir, packageJSON, targetArch, targetPlatform }) {
    const zipName = `${path.basename(dir)}-${packageJSON.version}.zip`;
    const zipPath = path.resolve(makeDir, 'zip', targetPlatform, targetArch, zipName);
    await createZipFromDirectory(dir, zipPath);
    return [zipPath];
  }
}

module.exports = NodeZipMaker;
module.exports.createZipFromDirectory = createZipFromDirectory;
