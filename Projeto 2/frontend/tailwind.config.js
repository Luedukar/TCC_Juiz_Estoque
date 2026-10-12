/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: { colors: { ink: '#1d2927', muted: '#74807d', brand: '#23665b', canvas: '#f5f7f6' }, boxShadow: { panel: '0 4px 18px rgba(20, 48, 42, .045)' } } },
  plugins: [],
};
