/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  // Phase 9.1: Force executionEngineV2=true for all tests
  setupFilesAfterFramework: ['<rootDir>/src/tests/setup/v2-global-setup.ts'],
  testMatch: [
    '**/src/workflow/tests/**/*.test.ts',
    '**/src/tests/integration/**/*.test.ts',
    '**/src/tests/unit/**/*.test.ts',
    '**/src/tests/execution/**/*.test.ts',
    '**/src/tests/tools/**/*.test.ts',
    '**/src/tests/skills/**/*.test.ts',
  ],
  moduleNameMapper: {
    '^vscode$': '<rootDir>/src/__mocks__/vscode.ts',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  // Exclude compiled output so jest-haste-map doesn't find out/__mocks__/vscode.js
  // alongside src/__mocks__/vscode.ts and emit a duplicate-mock warning.
  modulePathIgnorePatterns: ['<rootDir>/out/'],
  testPathIgnorePatterns: ['<rootDir>/out/', '<rootDir>/node_modules/'],
  testTimeout: 30000,
};
