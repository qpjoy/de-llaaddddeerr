#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function patchGatewayCaddyfile(content, upstream) {
  if (!/^(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:.]+\]):18090$/.test(upstream)) {
    throw new Error('Internal gateway upstream must be a host:18090 address');
  }
  // Restrict edits to the generated Internal listener. App routes in :80/:8008
  // may also target port 18090 and must not be changed. Generated closing braces
  // use the same indentation as their site header; nested blocks are indented.
  const blocks = [...content.matchAll(/^([ \t]*):18090[ \t]+\{[ \t]*(?:#[^\r\n]*)?\r?\n[\s\S]*?^\1\}[ \t]*(?:#[^\r\n]*)?(?=\r?$)/gm)];
  if (blocks.length !== 1) throw new Error('expected exactly one generated :18090 gateway block; existing configuration was not changed');
  const block = blocks[0][0];
  const directives = block.match(/^[ \t]*reverse_proxy\b/gm) ?? [];
  let replacements = 0;
  const updated = block.replace(/^([ \t]*reverse_proxy[ \t]+)(?:[a-zA-Z0-9.-]+|\[[a-fA-F0-9:.]+\]):18090([ \t]*(?:\{[ \t]*)?(?:#[^\r\n]*)?)(\r?)$/gm,
    (_, prefix, suffix, cr) => {
      replacements++;
      return `${prefix}${upstream}${suffix}${cr}`;
    });
  if (![1, 2].includes(replacements) || replacements !== directives.length) {
    throw new Error('unsupported Internal gateway reverse_proxy layout; expected one legacy or two managed API routes; existing configuration was not changed');
  }
  // Change addresses only. In particular keep both domestic-edge and direct
  // request header_up policies byte-for-byte, including their block braces.
  const start = blocks[0].index;
  return content.slice(0, start) + updated + content.slice(start + block.length);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [input, output, upstream] = process.argv.slice(2);
    if (!input || !output || !upstream) throw new Error('usage: k8s-gateway-caddyfile.mjs <input> <output> <host:18090>');
    const patched = patchGatewayCaddyfile(readFileSync(input, 'utf8'), upstream);
    writeFileSync(output, patched, { mode: 0o600 });
  } catch (error) {
    console.error(`gateway Caddyfile update failed: ${error.message}`);
    process.exitCode = 1;
  }
}
