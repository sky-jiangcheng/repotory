import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base depends on the build target:
//   - default (Wails desktop): relative './' — the frontend runs under a
//     non-HTTP origin (wails:// / file://), so absolute /assets/ paths fail to
//     resolve and dynamic imports throw "The string did not match the expected pattern".
//   - `--mode server` (repotory-server --web-dist rehearsal/self-hosted stack):
//     absolute '/' — the SPA is served from an HTTP origin at the root. With
//     the relative base, a deep link like /project/1 would resolve ./assets
//     under /project/ and the missing-file fallback (index.html) would be
//     rejected by the browser on MIME type, blanking the page.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'server' ? '/' : './',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:18765',
        changeOrigin: true,
      },
    },
    allowedHosts: ['.monkeycode-ai.online'],
  },
  build: {
    outDir: 'dist',
    // Let the npm build script wipe dist; Vite's built-in emptyOutDir triggers
    // bulk-delete guards in this environment.
    //
    // The wipe is done by scripts/prune-web-dist.mjs, which reads Vite's own
    // .vite/manifest.json and deletes only the files this build did NOT
    // produce. Without it, every build leaves the previous build's chunks
    // behind — 15 copies of the 1.4MB elk chunk accumulated, and since
    // web/dist is embedded whole into the binary (go:embed all:web/dist),
    // those orphans were shipped inside the executable.
    emptyOutDir: false,
    // The manifest is what makes the prune precise: it lists exactly what
    // this build references, so the cleanup can tell orphans from live files
    // instead of guessing by age.
    //
    // Side effect: `go:embed all:web/dist` (main.go) also embeds this file,
    // since the `all:` prefix includes dot-directories. Cost is ~65 KB on a
    // ~20 MB binary — a fair price for a cleanup that cannot misfire.
    manifest: true,
    // The only remaining chunk above the 500 kB default is mermaid's shared
    // diagram engine (~660 kB). Mermaid is imported on demand in
    // utils/markdown.ts, so it never sits on the initial-load path and cannot
    // be split further upstream.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Ensure each page becomes its own chunk so lazy-loaded navigation
        // only fetches the code needed for the destination route.
        manualChunks(id) {
          if (id.includes('src/pages/Home')) return 'home'
          if (id.includes('src/pages/Dashboard')) return 'dashboard'
          if (id.includes('src/pages/Knowledge')) return 'knowledge'
          if (id.includes('src/pages/ProjectDetail')) return 'projectDetail'
          if (id.includes('src/pages/Settings')) return 'settings'
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    // ADR-0026 条件 4：globals 开起来，测试运行器才会注册 testing-library 的自动
    // cleanup——在此之前 7 个文件各自手写 `afterEach(cleanup)`，是复制出来的约定。
    // 各文件仍显式 import describe/it/expect/vi，这条 house style 不变；globals 只是
    // 让 RTL 的 afterEach 自动卸载生效。
    globals: true,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environmentOptions: {
      jsdom: {
        url: 'http://localhost',
      },
    },
    env: {
      NODE_ENV: 'development',
    },
  },
}))
