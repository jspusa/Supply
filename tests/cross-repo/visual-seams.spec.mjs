import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const supplyRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fbaRepo = path.resolve(process.env.FBA_REPO || path.join(supplyRepo, '..', 'FBA'));
const pages = [
  ['index.html', '補貨整合'],
  ['inbound-plan.html', '入庫計畫'],
  ['shipment.html', '棧板擷取'],
  ['sorter.html', 'FBA 整理'],
  ['email.html', '出貨通知'],
];
const mime = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
]);
let server;
let origin;

function serve(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const relative = decodeURIComponent(url.pathname).replace(/^\/FBA\/?/, '') || 'index.html';
  const filePath = path.resolve(fbaRepo, relative);
  if (!filePath.startsWith(`${fbaRepo}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404).end('not found');
    return;
  }
  response.writeHead(200, {
    'Cache-Control':'no-store',
    'Content-Type':mime.get(path.extname(filePath)) || 'application/octet-stream',
  });
  response.end(fs.readFileSync(filePath));
}

test.beforeAll(async () => {
  for (const [file] of pages) {
    if (!fs.existsSync(path.join(fbaRepo, file))) throw new Error(`FBA visual seam requires ${file}`);
  }
  server = http.createServer(serve);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

test('FBA authoritative visual system covers all five pages at desktop and mobile', async ({ page, context }) => {
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, route => route.abort());
  for (const viewport of [{ width:1440, height:900 }, { width:390, height:844 }]) {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion:viewport.width === 390 ? 'reduce' : 'no-preference' });
    for (const [file, activeLabel] of pages) {
      await page.goto(`${origin}/FBA/${file}`, { waitUntil:'domcontentloaded' });
      const header = page.locator('.app-header');
      await expect(header).toBeVisible();
      await expect(header.locator('.brand-mark')).toHaveText('J');
      await expect(header.locator('.brand-copy strong')).toContainText('補貨工作台');
      await expect(header.locator('.top-tab')).toHaveCount(5);
      await expect(header.locator('.top-tab.active')).toHaveText(activeLabel);
      const shell = await page.evaluate(() => {
        const body = getComputedStyle(document.body);
        const headerStyle = getComputedStyle(document.querySelector('.app-header'));
        const active = getComputedStyle(document.querySelector('.top-tab.active'));
        return {
          bodyBackground:body.backgroundColor,
          font:body.fontFamily,
          headerPosition:headerStyle.position,
          headerBackdrop:headerStyle.backdropFilter,
          activeRadius:Number.parseFloat(active.borderRadius),
          version:getComputedStyle(document.documentElement).getPropertyValue('--fba-vs-version').trim(),
          viewportWidth:document.documentElement.clientWidth,
          pageWidth:document.documentElement.scrollWidth,
          overflow:Array.from(document.querySelectorAll('body *'))
            .map(element => ({ element, rect:element.getBoundingClientRect() }))
            .filter(item => item.rect.right > document.documentElement.clientWidth + 1 || item.rect.left < -1)
            .slice(0, 8)
            .map(item => `${item.element.tagName.toLowerCase()}${item.element.id ? `#${item.element.id}` : ''}${item.element.classList.length ? `.${[...item.element.classList].join('.')}` : ''}:${Math.round(item.rect.left)}..${Math.round(item.rect.right)}`),
        };
      });
      expect(shell).toMatchObject({
        bodyBackground:'rgb(245, 245, 247)',
        headerPosition:'sticky',
        version:'"1.0.0"',
        viewportWidth:viewport.width,
      });
      expect(shell.pageWidth, `${file} must not create page-level horizontal overflow at ${viewport.width}px; ${shell.overflow.join(', ')}`).toBe(viewport.width);
      expect(shell.font).toContain('-apple-system');
      expect(shell.headerBackdrop).toContain('blur(22px)');
      expect(shell.activeRadius).toBeGreaterThanOrEqual(8);
      if (viewport.width === 390) await expect(header.locator('.brand-copy span')).toBeHidden();
      else await expect(header.locator('.brand-copy span')).toHaveText('Jasper Pet Care Products, Inc.');
    }
  }
});
