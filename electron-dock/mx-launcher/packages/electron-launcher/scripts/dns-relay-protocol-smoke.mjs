import assert from 'node:assert/strict';

import { buildElectronLauncherDnsRelayFallbackResponse } from '../dist/system-domain-proxy.js';

function dnsQuery(host, type) {
  const labels = host.split('.').map((label) => {
    const bytes = Buffer.from(label, 'ascii');
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x2053, 0);
  header.writeUInt16BE(0x0120, 2); // RD + AD from the client; AD must not leak into a synthetic answer.
  header.writeUInt16BE(1, 4);
  return Buffer.concat([
    header,
    ...labels,
    Buffer.from([0, type >> 8, type & 0xff, 0, 1])
  ]);
}

function responseFlags(packet) {
  return packet.readUInt16BE(2);
}

const aResponse = buildElectronLauncherDnsRelayFallbackResponse(
  dnsQuery('delta.mxinfo-inc.cn', 1),
  '10.88.88.88'
);
assert.equal(aResponse.readUInt16BE(6), 1, 'A query should have one answer');
assert.equal(aResponse.readUInt16BE(aResponse.length - 14), 1, 'synthetic answer must be type A');
assert.equal(responseFlags(aResponse) & 0x0020, 0, 'synthetic A answer must clear AD');
assert.equal(responseFlags(aResponse) & 0x000f, 0, 'synthetic A answer must be NOERROR');

const aaaaResponse = buildElectronLauncherDnsRelayFallbackResponse(
  dnsQuery('delta.mxinfo-inc.cn', 28),
  '10.88.88.88'
);
assert.equal(aaaaResponse.readUInt16BE(6), 0, 'AAAA query must not receive an A answer');
assert.equal(responseFlags(aaaaResponse) & 0x0020, 0, 'synthetic AAAA NODATA must clear AD');
assert.equal(responseFlags(aaaaResponse) & 0x000f, 0, 'synthetic AAAA response must be NODATA/NOERROR');

console.log('DNS relay protocol smoke passed: A is synthesized and AAAA returns NODATA.');
