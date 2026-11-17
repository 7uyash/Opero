import { config as loadEnv } from "dotenv";
import path from "node:path";

loadEnv({ path: path.resolve(__dirname, "../.env"), quiet: true });
process.env.NODE_ENV = "test";
// Tests never touch the development database.
if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set for tests");
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
