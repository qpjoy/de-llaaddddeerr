import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const gamesDir = join(root, "games");
const entries = await readdir(gamesDir, { withFileTypes: true });
const games = [];

for (const entry of entries) {
  if (!entry.isDirectory()) {
    continue;
  }

  const packagePath = join(gamesDir, entry.name, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const gamePackage = packageJson.qpjoyGame;

  if (gamePackage?.specVersion !== 1 || !gamePackage.manifest) {
    continue;
  }

  const manifest = JSON.parse(
    await readFile(join(gamesDir, entry.name, gamePackage.manifest), "utf8")
  );

  games.push({
    id: manifest.id,
    packageName: packageJson.name,
    displayName: manifest.name,
    version: packageJson.version,
    category: manifest.category,
    entry: manifest.entry,
    path: join("games", entry.name)
  });
}

console.log(JSON.stringify({ version: 1, games }, null, 2));
