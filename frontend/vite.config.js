import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  server: {
    port: 5173,
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        chat: resolve(__dirname, 'chat/index.html'),
        login: resolve(__dirname, 'login/index.html'),
        profile: resolve(__dirname, 'profile/index.html')
      }
    }
  }
});
