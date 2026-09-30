const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const directories = ["evoweb-exporter-extension", "scripts", "tests"];
let checked = 0;

for (const directory of directories) {
  for (const name of fs.readdirSync(path.join(root, directory))) {
    if (!/\.(?:js|cjs|mjs)$/.test(name)) continue;
    const file = path.join(root, directory, name);
    const result = spawnSync(process.execPath, ["--check", file], {
      stdio: "inherit",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
    checked++;
  }
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "evoweb-exporter-extension/manifest.json"), "utf8"),
);
const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (manifest.version !== metadata.version) {
  throw new Error("Extension and package versions must match.");
}
console.log(`Syntax checks passed for ${checked} files. Version: ${manifest.version}.`);
