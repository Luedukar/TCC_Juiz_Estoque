/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  // SWC compila os testes e o código (decorators + metadados de DI do Nest) sem checagem de tipos;
  // a checagem fica em `npm run typecheck`.
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          target: 'es2022',
          keepClassNames: true,
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
        },
        module: { type: 'commonjs' },
      },
    ],
  },
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
  testTimeout: 30_000,

  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/scripts/**', '!src/types/**'],
  coverageProvider: 'v8',
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov', 'json-summary', 'html'],
};
