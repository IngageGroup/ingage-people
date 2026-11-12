import { config as loadEnv } from "dotenv";
import { defineConfig } from "drizzle-kit";

// .env.local wins; .env.test (committed) points at the docker compose database.
if (!process.env["DATABASE_URL"]) loadEnv({ path: [".env.local", ".env.test"], quiet: true });

const url = process.env["DATABASE_URL"];
if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Export it or add it to .env.local " +
      "(local default: postgres://app:app@localhost:55432/app).",
  );
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
});
