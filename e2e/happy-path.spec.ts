import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Upload, review, negotiate, absorb the curveball, convert. The one journey that
 * has to work, walked the way a user walks it.
 */
test("a brand uploads a quotation and ends up with a purchase order", async ({ page }) => {
  await page.goto("/");

  await page.setInputFiles(
    'input[type="file"]',
    resolve(import.meta.dirname, "../fixtures/quotation_2.xlsx"),
  );
  await page.getByPlaceholder("e.g. prioritize lead time").first().fill(
    "prioritize lead time over cost, 30 day deadline",
  );
  await page.getByRole("button", { name: "Parse quotation" }).click();

  // Review: the parse landed and the note became a constraint the agent can act on.
  await expect(page.getByRole("heading", { name: "quotation_2.xlsx" })).toBeVisible();
  await expect(page.getByText("Baseline value")).toBeVisible();
  await expect(page.getByText("Hard deadline: 30 days")).toBeVisible();

  await page.getByRole("button", { name: /Negotiate .* units/ }).click();

  // The transcript arrives over SSE rather than in the initial payload.
  await expect(page.getByRole("heading", { name: "Negotiation" })).toBeVisible();
  await expect(page.getByText("Brand agent").first()).toBeVisible({ timeout: 60_000 });

  // The curveball: injected mid-negotiation, absorbed without starting again.
  const applyCap = page.getByRole("button", { name: /Apply the 60% cap/ });
  await expect(applyCap).toBeVisible({ timeout: 60_000 });
  const messagesBefore = await page.getByText(/round \d/).count();
  await applyCap.click();

  await expect(page.getByText("Capacity change absorbed")).toBeVisible({ timeout: 60_000 });
  // Resumed, not restarted: the rounds already on screen are still there and
  // more have been added on top of them.
  expect(await page.getByText(/round \d/).count()).toBeGreaterThan(messagesBefore);

  // The recommendation, with the working shown.
  await expect(page.getByText("Recommendation ready")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("Recommended")).toBeVisible();
  await expect(page.getByRole("heading", { name: "How the plans compared" })).toBeVisible();

  // Cost basis changes what is displayed, not what was decided.
  await page.getByRole("button", { name: "Quoted", exact: true }).click();
  await page.getByRole("button", { name: "Effective", exact: true }).click();

  await page.getByRole("button", { name: "Convert to purchase order" }).click();

  await expect(page).toHaveURL(/purchase-orders/);
  await expect(page.getByRole("heading", { name: "Purchase orders" })).toBeVisible();
  await expect(page.getByText(/PO-\d{4}-\d{4}/).first()).toBeVisible();

  // The PO carries the frozen terms and the effects the commit fired.
  await page.getByRole("button", { name: "View detail" }).first().click();
  await expect(page.getByText("Downstream effects")).toBeVisible();
  await expect(page.getByText("notify supplier")).toBeVisible();
  await expect(page.getByText(/Agreed terms, frozen/)).toBeVisible();
});

test("a file that is not a quotation is rejected with a readable message", async ({ page }) => {
  await page.goto("/");
  await page.setInputFiles(
    'input[type="file"]',
    resolve(import.meta.dirname, "../fixtures/products.csv"),
  );
  await page.getByRole("button", { name: "Parse quotation" }).click();

  await expect(page.getByText(/could not be read as a quotation/i)).toBeVisible({ timeout: 30_000 });
});
