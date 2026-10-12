module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFiles: ['dotenv/config'],
  testMatch: ['**/tests/**/*.test.ts'],
  clearMocks: true,
  collectCoverageFrom: ['src/services/**/*.ts'],
};
