/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif']
      },
      colors: {
        ink: '#17221f',
        muted: '#77817d',
        canvas: '#f6f7f5',
        line: '#e8ece8',
        brand: {
          50: '#eaf7f1',
          100: '#d0eee0',
          500: '#23865f',
          600: '#19734f',
          700: '#145c40'
        }
      },
      boxShadow: {
        soft: '0 12px 40px rgba(27, 50, 40, 0.06)'
      }
    }
  },
  plugins: []
};
