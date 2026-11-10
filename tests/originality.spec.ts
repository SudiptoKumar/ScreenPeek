import { test, expect } from '@playwright/test';
test('detail facts, visible Q&A and FAQ schema share stored data without aggregate ratings', async ({ page }) => {
  await page.goto('/movie/sample-the-quiet-atlas-1-2022/');
  await expect(page.locator('.title-originality')).toContainText('Sample:');
  await expect(page.locator('time[datetime]')).toBeVisible();
  const questions = page.getByRole('region', { name: 'Questions & answers' });
  await expect(questions.locator('details')).toHaveCount(3);
  const schemas = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent() || '[]');
  const faq = schemas.find((item: { '@type': string }) => item['@type'] === 'FAQPage');
  expect(faq.mainEntity).toHaveLength(3);
  for (let index = 0; index < 3; index++) {
    const details = questions.locator('details').nth(index); await details.locator('summary').click();
    await expect(details.locator('summary')).toHaveText(faq.mainEntity[index].name);
    await expect(details.locator('p')).toHaveText(faq.mainEntity[index].acceptedAnswer.text);
  }
  expect(JSON.stringify(schemas)).not.toMatch(/aggregateRating|"Review"/);
});
