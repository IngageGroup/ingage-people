import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "vitest/config";

// Tests against the docker compose Postgres (`docker compose up -d && pnpm db:migrate`).
// .env.test points at it unless DATABASE_URL is already set.
if (!process.env["DATABASE_URL"]) loadEnv({ path: ".env.test", quiet: true });

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.db.test.ts"],
    exclude: ["**/node_modules/**", "**/.claude/**"],
    // One shared database: run files one at a time.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
