import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/** Serious and critical axe findings, as readable lines, for the whole page or one part. */
async function seriousViolations(page: Page, selector?: string): Promise<string[]> {
  const builder = new AxeBuilder({ page });
  if (selector) builder.include(selector);
  const results = await builder.analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => `${violation.id}: ${violation.help}`);
}

test.describe('popup', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('lists detected media best-first, with the primary action first', async ({ page }) => {
    const popup = page.getByTestId('with-media');

    await expect(popup.getByRole('button', { name: 'Best download' })).toBeVisible();
    await expect(popup.getByText('6 detected')).toBeVisible();

    const titles = await popup.locator('article h3').allTextContents();
    expect(titles[0]).toBe('How to Build a Startup');
    expect(titles).toContain('Backstage interview');
  });

  test('refuses to offer a download for protected media', async ({ page }) => {
    const popup = page.getByTestId('with-media');
    const drmRow = popup.locator('article', { hasText: 'Feature film (protected)' });

    await expect(
      drmRow.getByText('Protected content. MediaGrab does not remove DRM.'),
    ).toBeVisible();
    await expect(drmRow.getByRole('button', { name: /Download/ })).toHaveCount(0);
  });

  test('expands the quality ladder on request', async ({ page }) => {
    const popup = page.getByTestId('with-media');
    const row = popup.locator('article', { hasText: 'How to Build a Startup' }).first();

    await row.getByRole('button', { name: '4 qualities' }).click();
    const ladder = row.locator('.ladder');
    await expect(ladder.getByRole('button', { name: /^4K/ })).toBeVisible();
    await expect(ladder.getByRole('button', { name: /^480p/ })).toBeVisible();
    await expect(ladder.getByRole('button')).toHaveCount(4);
  });

  test('shows a preview image beside each row that has one', async ({ page }) => {
    const popup = page.getByTestId('with-media');
    const row = popup.locator('article', { hasText: 'How to Build a Startup' }).first();

    const image = row.locator('.thumb img');
    await expect(image).toBeVisible();
    // The picture must have actually decoded, not just be present in the DOM.
    const width = await image.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    expect(width, 'the preview image did not load').toBeGreaterThan(0);
  });

  test('falls back to a labelled placeholder when there is no preview', async ({ page }) => {
    const popup = page.getByTestId('with-media');
    const audioRow = popup.locator('article', { hasText: 'Episode 14 - Scaling teams' });

    await expect(audioRow.locator('.thumb img')).toHaveCount(0);
    await expect(audioRow.locator('.thumb')).toContainText('mp3');
  });

  test('keeps every row the same height whether or not it has a preview', async ({ page }) => {
    const popup = page.getByTestId('with-media');
    const withImage = popup
      .locator('article', { hasText: 'Backstage interview' })
      .locator('.thumb');
    const withoutImage = popup
      .locator('article', { hasText: 'Episode 14 - Scaling teams' })
      .locator('.thumb');

    const a = await withImage.boundingBox();
    const b = await withoutImage.boundingBox();
    expect(a?.width).toBe(b?.width);
    expect(a?.height).toBe(b?.height);
  });

  test('explains why there is nothing to download instead of saying "no media"', async ({
    page,
  }) => {
    const popup = page.getByTestId('no-media');

    await expect(
      popup.getByRole('heading', { name: 'The player streams this in pieces' }),
    ).toBeVisible();
    await expect(popup.getByText('MSE_ONLY')).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Scan again' })).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Report this site' })).toBeVisible();
  });

  test('shows live download progress with speed and ETA', async ({ page }) => {
    const popup = page.getByTestId('with-media');
    await popup.getByRole('button', { name: /^Downloads/ }).click();

    // The list shows the file name, not the folder it will be written into.
    await expect(popup.getByText('How to Build a Startup [1080p].ts')).toBeVisible();
    await expect(popup.getByText('8.4 MB/s')).toBeVisible();
    await expect(popup.getByText('ETA 31 sec')).toBeVisible();
    await expect(popup.getByText('412/501 seg')).toBeVisible();
    await expect(popup.getByRole('progressbar').first()).toHaveAttribute('aria-valuenow', '82');
  });

  test('classifies a failed download rather than saying "download failed"', async ({ page }) => {
    const popup = page.getByTestId('with-media');
    await popup.getByRole('button', { name: /^Downloads/ }).click();

    const failed = popup.locator('article', { hasText: 'Feature film [1080p].mp4' });
    await expect(
      failed.getByText('The link expired. Reload the page and scan again.'),
    ).toBeVisible();
    await expect(failed.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('D18: a host that refused MediaGrab is offered for a grant, with a retry', async ({
    page,
  }) => {
    const popup = page.getByTestId('with-media');
    await popup.getByRole('button', { name: /^Downloads/ }).click();

    const failed = popup.locator('article', { hasText: 'Trailer [720p].mp4' });
    await expect(
      failed.getByText('partner-cdn.test refused MediaGrab.', { exact: false }),
    ).toBeVisible();
    await expect(failed.getByText('HTTP 403')).toBeVisible();
    await failed
      .getByRole('button', { name: 'Allow partner-cdn.test and retry Trailer [720p].mp4' })
      .click();
    await expect(popup.getByText('was not given access')).toHaveCount(0);
  });

  test('has no serious or critical accessibility violations', async ({ page }) => {
    await expect(page.getByTestId('with-media').getByText('6 detected')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('has no serious or critical accessibility violations in dark mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expect(page.getByTestId('with-media').getByText('6 detected')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });

  test('is usable by keyboard alone', async ({ page }) => {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.tagName ?? '');
    expect(focused).toBe('BUTTON');

    const outline = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      return element ? getComputedStyle(element).boxShadow : '';
    });
    expect(outline).not.toBe('none');
  });
});

test.describe('popup states the controller reaches', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('regression C2: after "Enable on this site" the reload notice stays up', async ({
    page,
  }) => {
    const popup = page.getByTestId('needs-access');
    await popup.getByRole('button', { name: 'Enable on this site' }).click();

    await expect(popup.getByRole('button', { name: 'Best download' })).toBeVisible();
    await expect(popup.getByRole('status')).toHaveText(/Access granted\. Reload the page/);
  });

  test('regression C17: a scan that did not finish says so and offers to scan again', async ({
    page,
  }) => {
    const popup = page.getByTestId('scan-failed');

    await expect(popup.getByText('MediaGrab could not scan this page.')).toBeVisible();
    await expect(popup.getByText('Scanning this page…')).toHaveCount(0);
    await popup.getByRole('button', { name: 'Scan again' }).click();
    await expect(popup.getByText('6 detected')).toBeVisible();
  });

  test('regression C18: "Best download" is disabled, with the reason, when everything is protected', async ({
    page,
  }) => {
    const best = page.getByTestId('protected-only').getByRole('button', { name: 'Best download' });

    await expect(best).toBeDisabled();
    await expect(best).toHaveAccessibleDescription(/Everything found here is protected/);
  });

  test('regression C9: a rendition without sound says so on its download buttons', async ({
    page,
  }) => {
    const popup = page.getByTestId('video-only');
    await popup.getByRole('button', { name: '3 downloads' }).click();
    const ladder = popup.locator('.ladder');

    await expect(
      ladder.getByRole('button', { name: /^1080p.*video only — no sound/ }),
    ).toBeVisible();
    await expect(
      ladder.getByRole('button', { name: /^720p.*video only — no sound/ }),
    ).toBeVisible();
    await expect(page.getByTestId('with-media').getByText('video only — no sound')).toHaveCount(0);
  });

  test('D20: "Best download" on a split stream says, and queues, video and audio as separate files', async ({
    page,
  }) => {
    const popup = page.getByTestId('video-only');
    const best = popup.getByRole('button', { name: 'Best download' });

    await expect(best).toHaveAccessibleDescription('video and audio as separate files');
    await expect(popup.getByRole('button', { name: 'Download 1080p' })).toHaveAccessibleDescription(
      'video and audio as separate files',
    );

    await best.click();
    await expect(popup.getByRole('button', { name: /^Downloads/, pressed: true })).toBeVisible();
    const queued = popup.locator('article');
    await expect(queued).toHaveCount(2);
    await expect(queued.filter({ hasText: '[1080p]' })).toHaveCount(1);
    await expect(queued.filter({ hasText: '[Audio - AAC - 128 kbps]' })).toHaveCount(1);
    expect(await seriousViolations(page, '[data-testid="video-only"]')).toEqual([]);
  });

  test('D21: a row that cannot be saved is shown, disabled, with its reason', async ({ page }) => {
    const popup = page.getByTestId('with-media');
    const encrypted = popup.locator('article', { hasText: 'Members-only replay' });
    const live = popup.locator('article', { hasText: 'Studio camera' });

    await expect(
      encrypted.getByText(
        'Encrypted stream. MediaGrab does not decrypt, so the file would not play.',
      ),
    ).toBeVisible();
    await expect(encrypted.getByRole('button', { name: /Download/ })).toHaveCount(0);
    await expect(
      live.getByText('Live stream. MediaGrab saves finished videos, not live broadcasts.'),
    ).toBeVisible();
    await expect(live.getByRole('button', { name: /Download/ })).toHaveCount(0);
  });

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`D21: a rendition too large to assemble is disabled with its reason, and Best takes the next (${colorScheme})`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme });
      await page.reload();
      const popup = page.getByTestId('with-media');
      const row = popup.locator('article', { hasText: 'How to Build a Startup' }).first();

      await expect(row.getByRole('button', { name: 'Download 1080p' })).toBeVisible();
      await row.getByRole('button', { name: '4 qualities' }).click();
      const uhd = row.locator('.ladder').getByRole('button', { name: /^4K/ });
      await expect(uhd).toBeDisabled();
      await expect(uhd).toHaveAccessibleDescription('Too large to assemble in the browser.');
      await expect(row.locator('.ladder').getByRole('button', { name: /^1080p/ })).toBeEnabled();
      expect(await seriousViolations(page, '[data-testid="with-media"]')).toEqual([]);
    });
  }
});

test.describe('downloads view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page
      .getByTestId('with-media')
      .getByRole('button', { name: /^Downloads/ })
      .click();
  });

  test('regression C10: offers Pause only where the browser keeps the partial file', async ({
    page,
  }) => {
    const popup = page.getByTestId('with-media');
    const segmented = popup.locator('article', { hasText: 'How to Build a Startup [1080p].ts' });
    const direct = popup.locator('article', { hasText: 'Backstage interview.mp4' });

    await expect(segmented.getByRole('button', { name: /^Pause/ })).toHaveCount(0);
    await expect(segmented.getByRole('button', { name: /^Cancel/ })).toBeVisible();
    await expect(direct.getByRole('button', { name: /^Pause/ })).toBeVisible();
  });

  test('regression C7: shows an estimated total with "~"', async ({ page }) => {
    const popup = page.getByTestId('with-media');
    const segmented = popup.locator('article', { hasText: 'How to Build a Startup [1080p].ts' });
    const direct = popup.locator('article', { hasText: 'Backstage interview.mp4' });

    await expect(segmented.getByText('1.20 GB / ~1.46 GB')).toBeVisible();
    await expect(direct.getByText('35 MB / 141 MB')).toBeVisible();
  });

  test('regression C23: names every progress bar and every row button, and marks the view', async ({
    page,
  }) => {
    const popup = page.getByTestId('with-media');

    await expect(
      popup.getByRole('progressbar', { name: 'Progress of How to Build a Startup [1080p].ts' }),
    ).toBeVisible();
    await expect(
      popup.getByRole('button', { name: 'Cancel Backstage interview.mp4' }),
    ).toBeVisible();
    await expect(popup.getByRole('button', { name: /^Downloads/, pressed: true })).toBeVisible();
    await expect(popup.getByRole('button', { name: 'Media', pressed: false })).toBeVisible();
    expect(await seriousViolations(page, '[data-testid="with-media"]')).toEqual([]);
  });
});

test.describe('options', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('shows the privacy position and the naming template', async ({ page }) => {
    const options = page.locator('.options-frame');

    await expect(options.getByRole('heading', { name: 'Privacy' })).toBeVisible();
    await expect(options.getByText(/MediaGrab has no backend/)).toBeVisible();
    await expect(options.getByRole('heading', { name: 'Site access' })).toBeVisible();
  });

  test('regression C14: all-sites access is a status, not a checkbox that stays ticked', async ({
    page,
  }) => {
    const options = page.locator('.options-frame');

    // The harness browser already holds every permission.
    await expect(options.getByText('Allowed on all sites.')).toBeVisible();
    await expect(options.getByRole('checkbox', { name: /all sites/ })).toHaveCount(0);
  });

  test('regression C15: shows the value that was saved, not the one typed', async ({ page }) => {
    const concurrent = page.locator('.options-frame').getByLabel('Concurrent downloads');

    await concurrent.fill('20');
    await concurrent.press('Tab');
    await expect(concurrent).toHaveValue('8');

    await concurrent.fill('');
    await concurrent.press('Tab');
    await expect(concurrent).toHaveValue('3');
  });
});
