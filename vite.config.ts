/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const functionProxy = { '/functions/v1/app': 'http://127.0.0.1:8000' };

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', proxy: functionProxy },
  preview: { host: '127.0.0.1', proxy: functionProxy },
  build: { outDir: 'dist' },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Only LLM_* from .env.local reach tests, for createLLMClient({ mode: 'node' }).
    env: loadEnv(mode, process.cwd(), 'LLM_'),
  },
}));
