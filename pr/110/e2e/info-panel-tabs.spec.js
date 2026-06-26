// E2E: responsive Info-Panel tab bar with the "More ▾" overflow dropdown.
//
// Covers the behavior added in setupPanelTabs() (ui/info-panel.js): tabs that
// don't fit the panel's current width are demoted into a "More ▾" dropdown,
// and widening the panel promotes them back into the bar one at a time — only
// when the full name fits, never truncated.
const { test, expect } = require('@playwright/test');

// All six tab names (uppercased by CSS, but textContent stays title-case).
const ALL_TABS = ['Instances', 'Visibility', 'Videos', 'Cameras', 'Skeleton', 'Session'];

// Resize the Info Panel to `px` and wait for the ResizeObserver-driven
// layoutPanelTabs() to settle. The drag handler sets both width and minWidth,
// so we mirror that here.
async function setPanelWidth(page, px) {
  await page.evaluate((w) => {
    const panel = document.getElementById('infoPanel');
    panel.style.width = w + 'px';
    panel.style.minWidth = w + 'px';
  }, px);
  // ResizeObserver fires on a future frame — give it one.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

// Names of the tabs currently rendered in the bar (not display:none).
async function visibleBarTabs(page) {
  return page.$$eval('.panel-tab[data-tab]', (els) =>
    els.filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim())
  );
}

// Names of tabs currently inside the More dropdown menu.
async function dropdownTabs(page) {
  return page.$$eval('.panel-tab-more-item', (els) => els.map((e) => e.textContent.trim()));
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/index.html');
  // setupPanelTabs() runs during init() and creates the More control.
  await page.waitForSelector('.panel-tab-more-btn', { state: 'attached' });
  page._jsErrors = errors;
});

test('static markup exposes all six tabs plus the More control', async ({ page }) => {
  const dataTabs = await page.$$eval('.panel-tab[data-tab]', (els) =>
    els.map((e) => e.textContent.trim())
  );
  expect(dataTabs).toEqual(ALL_TABS);
  await expect(page.locator('.panel-tab-more-btn')).toHaveCount(1);
});

test('at the default narrow width, overflow tabs collapse into More ▾', async ({ page }) => {
  await setPanelWidth(page, 300);

  // More button is shown when something overflows.
  await expect(page.locator('.panel-tab-more')).toBeVisible();

  const inBar = await visibleBarTabs(page);
  // The first tab always stays; the trailing ones overflow.
  expect(inBar[0]).toBe('Instances');
  expect(inBar).not.toContain('Session');

  // Open the dropdown and confirm the overflowed tabs live there, and that
  // together the bar + dropdown account for every tab (nothing lost).
  await page.locator('.panel-tab-more-btn').click();
  await expect(page.locator('.panel-tab-more')).toHaveClass(/open/);
  const inMenu = await dropdownTabs(page);
  expect(inMenu).toContain('Session');
  expect([...inBar, ...inMenu].sort()).toEqual([...ALL_TABS].sort());
});

test('selecting an overflowed tab from the dropdown activates its content', async ({ page }) => {
  await setPanelWidth(page, 300);
  await page.locator('.panel-tab-more-btn').click();

  const sessionItem = page.locator('.panel-tab-more-item', { hasText: 'Session' });
  await sessionItem.click();

  // The Session tab-content pane becomes active...
  await expect(page.locator('#tabSession')).toHaveClass(/active/);
  // ...the dropdown closes...
  await expect(page.locator('.panel-tab-more')).not.toHaveClass(/open/);
  // ...and the More button reflects that the active tab lives inside it.
  await expect(page.locator('.panel-tab-more-btn')).toHaveClass(/active/);
});

test('widening the panel promotes every tab back into the bar', async ({ page }) => {
  // Start narrow (overflow), then widen well past the natural total width.
  await setPanelWidth(page, 300);
  expect(await visibleBarTabs(page)).not.toEqual(ALL_TABS);

  await setPanelWidth(page, 1000);

  // All six tabs fit -> all visible, More control hidden.
  await expect.poll(() => visibleBarTabs(page)).toEqual(ALL_TABS);
  await expect(page.locator('.panel-tab-more')).toBeHidden();
});

test('promotion is monotonic: more tabs fit as the panel grows', async ({ page }) => {
  await setPanelWidth(page, 240);
  const narrow = (await visibleBarTabs(page)).length;

  await setPanelWidth(page, 500);
  const mid = (await visibleBarTabs(page)).length;

  expect(mid).toBeGreaterThanOrEqual(narrow);
  expect(narrow).toBeGreaterThanOrEqual(1); // first tab always kept
});

test.afterEach(async ({ page }) => {
  expect(page._jsErrors, 'no uncaught page errors').toEqual([]);
});
