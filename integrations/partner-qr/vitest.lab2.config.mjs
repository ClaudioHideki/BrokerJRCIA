import {defineConfig} from 'vitest/config';
export default defineConfig({test:{include:['integrations/partner-qr/tests/lab2/*.test.mjs'],testTimeout:30000,maxWorkers:1}});
