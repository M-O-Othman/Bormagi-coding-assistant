/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/src/workflow/tests/**/*.test.ts',
    '**/src/tests/integration/**/*.test.ts',
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
