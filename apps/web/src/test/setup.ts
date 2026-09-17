import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// The full suite also runs PDF rendering and builds on shared CI/local hosts.
// Preserve assertions while allowing async UI updates more than the default 1s.
configure({ asyncUtilTimeout: 10000 });

afterEach(() => {
  cleanup();
  if (typeof window !== 'undefined') {
    window.localStorage.clear();
    window.sessionStorage.clear();
  }
});
