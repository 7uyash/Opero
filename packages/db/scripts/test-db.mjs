// Runs a Prisma CLI command against TEST_DATABASE_URL: node scripts/test-db.mjs migrate deploy
import { spawnSync } from "node:child_process";
if (!process.env.TEST_DATABASE_URL) {
  console.error("TEST_DATABASE_URL is not set");
  process.exit(1);
}
const r = spawnSync("prisma", process.argv.slice(2), {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
});
process.exit(r.status ?? 1);
