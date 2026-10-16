import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";

// Local development talks to a local Eval API; the dev proxy plays the Worker's part and adds the service token.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiOrigin = env.EVAL_API_ORIGIN ?? "http://127.0.0.1:18788";
  return {
    plugins: [
      tanstackRouter({ target: "react", autoCodeSplitting: true }),
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
      dedupe: ["react", "react-dom", "@tanstack/react-query", "@springbrand/http", "@springbrand/site-block"],
    },
    optimizeDeps: {
      // This ESM package needs Vite's asset transforms for URL imports, CSS and Workers.
      exclude: ["@springbrand/file-renderers"],
    },
    server: {
      proxy: {
        "/api": {
          target: apiOrigin,
          changeOrigin: true,
          configure(proxy) {
            proxy.on("proxyReq", (request) => {
              if (env.EVAL_WEB_API_TOKEN) request.setHeader("X-Eval-Web-Token", env.EVAL_WEB_API_TOKEN);
              request.setHeader("X-Eval-Actor", encodeURIComponent(JSON.stringify({ id: "local-dev", name: "本地开发" })));
              // Eval API trusts only its configured Web origin.
              request.setHeader("Origin", env.EVAL_WEB_ORIGIN ?? "http://localhost:5176");
            });
          },
        },
      },
    },
  };
});
