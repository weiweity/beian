import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { API_DOWN_LOCAL } from "./src/apiHint";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
        configure(proxy) {
          proxy.on("error", (_err, _req, res) => {
            const out = res as {
              headersSent?: boolean;
              writeHead?: (code: number, h: Record<string, string>) => void;
              end?: (b: string) => void;
              destroy?: (e?: Error) => void;
            };
            try {
              if (out.writeHead && !out.headersSent) {
                out.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
                out.end(JSON.stringify({ detail: API_DOWN_LOCAL }));
                return;
              }
            } catch {
              /* already closed */
            }
            try {
              out.destroy?.();
            } catch {
              /* ignore */
            }
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/@google/model-viewer") || id.includes("/three/")) {
            return "model-viewer";
          }
        },
      },
    },
  },
});
