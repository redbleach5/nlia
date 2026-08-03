import { defineConfig } from "drizzle-kit";

const dbPath = process.env.LIA_DB_PATH ?? "./data/lia.db";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: dbPath,
  },
  verbose: true,
  strict: true,
});
