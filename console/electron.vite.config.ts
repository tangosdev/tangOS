import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// NOTE: we intentionally do NOT externalize dependencies (`externalizeDeps: false`; electron-vite 5
// turns it on by default). Bundling the npm deps
// (express, @modelcontextprotocol/sdk, zod) into the main/preload output makes the
// packaged app self-contained - no runtime node_modules - which sidesteps the
// hoisted-node_modules problem when packaging this workspace member with electron-builder.
// electron-vite still keeps `electron` and Node builtins external automatically.
export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
