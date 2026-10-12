import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Em desenvolvimento e no `vite preview`, /api é repassado ao backend (evita CORS).
const proxy = {
  '/api': { target: process.env.API_PROXY ?? 'http://localhost:3000', changeOrigin: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, proxy },
  preview: { port: 4173, proxy },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'], restoreMocks: true },
});
