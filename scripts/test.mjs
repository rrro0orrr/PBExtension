// Runs `paperback-cli test`. The toolchain's test sandbox references
// Float16Array, which Node < 24 only exposes behind --js-float16array.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const cli = join(dirname(require.resolve("@paperback/toolchain/package.json")), "dist/cli.mjs");

const nodeFlags = typeof Float16Array === "undefined" ? ["--js-float16array"] : [];
const result = spawnSync(process.execPath, [...nodeFlags, cli, "test", ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
