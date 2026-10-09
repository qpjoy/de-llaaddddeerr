import { readFile } from "node:fs/promises";
const cfg = JSON.parse(await readFile(".runtime/config.json", "utf8"));
const key = process.argv[2] === "test" ? "testToken" : "adminToken";
console.log(cfg[key]);
