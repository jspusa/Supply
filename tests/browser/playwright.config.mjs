import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir:import.meta.dirname,
  testMatch:/.*\.spec\.mjs$/,
  fullyParallel:false,
  workers:1,
  retries:0,
  forbidOnly:Boolean(process.env.CI),
  timeout:45_000,
  expect:{ timeout:6_000 },
  reporter:'line',
  outputDir:path.join(os.tmpdir(), 'supply-playwright-output'),
  use:{
    baseURL:'http://127.0.0.1:4173',
    browserName:'chromium',
    headless:true,
    viewport:{ width:1280, height:900 },
    locale:'zh-TW',
    timezoneId:'Asia/Taipei',
    acceptDownloads:true,
    actionTimeout:6_000,
    navigationTimeout:10_000,
    trace:'retain-on-failure',
  },
  webServer:{
    command:'node scripts/serve-dist.mjs',
    cwd:path.resolve(import.meta.dirname, '..', '..'),
    env:{ SUPPLY_DIST_PORT:'4173' },
    url:'http://127.0.0.1:4173/release.json',
    timeout:10_000,
    reuseExistingServer:false,
  },
});
