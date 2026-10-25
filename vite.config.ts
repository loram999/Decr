import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig, Plugin } from 'vite';

// Security plugin: Never serve or bundle .py, .db, .key, or .log files from public/ or root
function blockSensitiveStaticFiles(): Plugin {
  const blockedPattern = /(gateway_store\.json|\.(py|db|sqlite|sqlite3|key|log|env|rules))(\?.*)?$/i;
  return {
    name: 'block-sensitive-static-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        if (blockedPattern.test(url)) {
          res.statusCode = 404;
          res.end('Not Found');
          return;
        }
        next();
      });
    },
    closeBundle() {
      const distAssetsDir = path.resolve(__dirname, 'dist/assets/aistudio');
      if (fs.existsSync(distAssetsDir)) {
        for (const file of fs.readdirSync(distAssetsDir)) {
          if (file.endsWith('.py')) {
            fs.rmSync(path.join(distAssetsDir, file), { force: true });
          }
        }
      }
    },
  };
}

export default defineConfig(() => {
  return {
    plugins: [blockSensitiveStaticFiles(), react(), tailwindcss()],
    build: {
      sourcemap: false,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
