/**
 * Phase 9.1 — Force executionEngineV2=true for every test in the suite.
 *
 * Loaded via jest.config.js `setupFilesAfterEnv`.
 * Calls __setConfig before each test so the V2 flag is active regardless
 * of what individual test files configure.
 */
import { __setConfig } from '../../__mocks__/vscode';

beforeEach(() => {
  __setConfig('bormagi', { executionEngineV2: true });
});
