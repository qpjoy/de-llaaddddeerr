import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const registryPath = join(root, "registry", "games.json");
const registry = JSON.parse(await readFile(registryPath, "utf8"));
const sudukuPackage = JSON.parse(
  await readFile(join(root, "games", "suduku", "package.json"), "utf8")
);
const sudukuPluginManifest = JSON.parse(
  await readFile(join(root, "games", "suduku", sudukuPackage.qpjoyPlugin.manifest), "utf8")
);
const sudukuGameManifest = JSON.parse(
  await readFile(join(root, "games", "suduku", sudukuPackage.qpjoyGame.manifest), "utf8")
);

if (!Array.isArray(registry.games)) {
  throw new Error("registry/games.json must contain a games array");
}

for (const game of registry.games) {
  for (const field of ["id", "packageName", "displayName", "version", "category"]) {
    if (!game[field]) {
      throw new Error(`registry game ${game.id || "(unknown)"} is missing ${field}`);
    }
  }
}

if (sudukuPackage.qpjoyPlugin.specVersion !== 1 || sudukuPackage.qpjoyGame.specVersion !== 1) {
  throw new Error("Suduku package must declare qpjoyPlugin and qpjoyGame specVersion 1");
}

if (sudukuPluginManifest.id !== sudukuGameManifest.id) {
  throw new Error("Suduku plugin and game manifests must use the same id");
}

if (sudukuPackage.version !== sudukuPluginManifest.version || sudukuPackage.version !== sudukuGameManifest.version) {
  throw new Error("Suduku manifest versions must match package.json#version");
}

const files = [
  "packages/electron-game-sdk/src/index.js",
  "scripts/discover-local.mjs",
  "games/suduku/src/player.js",
  "games/suduku/src/plugin.js",
  "games/suduku/src/main.js",
  "games/suduku/src/preload.js",
  "games/suduku/src/database.js",
  "games/suduku/src/sync.js",
  "games/suduku/renderer/app.js",
  "games/suduku/renderer/game.js"
];

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(`${file} failed syntax check:\n${result.stderr || result.stdout}`);
  }
}

console.log(`electron-game check passed for ${registry.games.length} game(s).`);
