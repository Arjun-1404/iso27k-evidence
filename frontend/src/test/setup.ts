import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { beforeAll, afterEach, afterAll } from 'vitest';
import { server } from './mswServer';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
// Order matters: unmount components (which aborts their in-flight fetches) BEFORE resetting MSW's
// handlers, or an abort can race a handler being swapped out mid-request and MSW logs a spurious
// unhandled-rejection for a request nothing was ever going to see the result of.
afterEach(() => { cleanup(); server.resetHandlers(); });
afterAll(() => server.close());
