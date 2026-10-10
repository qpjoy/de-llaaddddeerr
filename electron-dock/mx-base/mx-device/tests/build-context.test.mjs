import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

test("Docker build-stage COPY inputs compile without uncopied workspace files", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const buildStage = dockerfile.split(/^FROM /m)[1];
  assert.match(buildStage, /AS build/);
  const beforeBuild = buildStage.split(/^RUN npm run build/m)[0];
  assert.notEqual(beforeBuild, buildStage, "Expected the frontend build step");
  const stage = await mkdtemp(join(tmpdir(), "mx-device-build-context-"));
  try {
    // Stage the actual COPY inputs, then reuse installed dependencies only.
    // This runs Vite; checking the Dockerfile text alone would miss new imports.
    for (const line of beforeBuild.split("\n")) {
      if (!line.startsWith("COPY ")) continue;
      const tokens = line.trim().split(/\s+/).slice(1);
      const destination = tokens.pop();
      assert(tokens.every((source) => !source.startsWith("--")));
      for (const source of tokens) {
        let sources = [source];
        if (source.includes("*")) {
          const [prefix, suffix, extra] = source.split("*");
          assert.equal(extra, undefined, "Fixture supports one root wildcard");
          sources = (await readdir(root)).filter(
            (name) => name.startsWith(prefix) && name.endsWith(suffix),
          );
          assert(sources.length);
        }
        for (const entry of sources) {
          const target = destination.endsWith("/")
            ? join(stage, destination, basename(entry))
            : resolve(stage, destination);
          await cp(join(root, entry), target, { recursive: true });
        }
      }
    }
    await symlink(
      join(root, "node_modules"),
      join(stage, "node_modules"),
      "dir",
    );
    const build = spawnSync(
      process.execPath,
      [join(root, "node_modules/vite/bin/vite.js"), "build"],
      { cwd: stage, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(
      build.status,
      0,
      build.error?.message || build.stdout + build.stderr,
    );
    assert.match(
      await readFile(join(stage, "dist/index.html"), "utf8"),
      /\/assets\//,
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});
