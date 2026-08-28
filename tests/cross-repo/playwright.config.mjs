import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir:import.meta.dirname,
  testMatch:/(?:catalog|visual)-seams\.spec\.mjs$/,
  fullyParallel:false,
  workers:1,
  retries:0,
  timeout:45_000,
  expect:{ timeout:6_000 },
  reporter:'line',
  outputDir:path.join(os.tmpdir(), 'supply-fba-catalog-seams-playwright'),
  use:{
    browserName:'chromium',
    headless:true,
    viewport:{ width:1280, height:900 },
    locale:'zh-TW',
    timezoneId:'Asia/Taipei',
    actionTimeout:6_000,
    navigationTimeout:10_000,
    trace:'retain-on-failure',
  },
});
