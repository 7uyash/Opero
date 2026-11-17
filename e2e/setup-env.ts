import { config as loadEnv } from "dotenv";
import path from "node:path";

// Same database as the running app (it's the app's data we check), unlike unit tests.
loadEnv({ path: path.resolve(__dirname, "../.env"), quiet: true });
if (process.env.E2E_DATABASE_URL) process.env.DATABASE_URL = process.env.E2E_DATABASE_URL;
