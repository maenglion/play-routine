import { defineConfig } from 'vite';
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  server: { host: '0.0.0.0', port: 5176, allowedHosts: ['.manus.computer'] },
  build: { outDir: 'dist' },
});
