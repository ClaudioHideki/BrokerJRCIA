import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['integrations/partner-qr/tests/*.test.mjs'], testTimeout: 10000 } });
