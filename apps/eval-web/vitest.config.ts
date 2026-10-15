import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default defineConfig((env) => mergeConfig(
  typeof viteConfig === "function" ? viteConfig(env) : viteConfig,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./vitest.setup.ts"],
      include: ["src/**/*.test.{ts,tsx}", "worker/**/*.test.ts"],
    },
  }),
));
