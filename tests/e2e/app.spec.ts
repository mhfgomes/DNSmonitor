import { test, expect } from "@playwright/test";

test("operator can manage DNS monitors, incidents and alert settings", async ({
  page,
}) => {
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (entry) => {
    if (
      entry.type() === "error" &&
      /Content Security Policy|Refused to/.test(entry.text())
    )
      errors.push(entry.text());
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/login-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByLabel("Email address").fill("admin@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Monitors", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Production API", exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Light theme", exact: true }).click();
  await page.screenshot({
    path: "test-results/monitors-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Dark theme", exact: true }).click();
  await expect(page.locator("html")).toHaveClass("dark");
  await expect(
    page.getByRole("button", { name: "Dark theme", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: "test-results/monitors-dark.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Monitors", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Dark theme", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("link", { name: "Public website", exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Archived hourly history" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "12.0 / 12.0 ms" }),
  ).toBeVisible();
  await expect(
    page.getByText("No retained check details", { exact: true }),
  ).toBeVisible();
  await page
    .locator("section")
    .filter({
      has: page.getByRole("heading", { name: "Archived hourly history" }),
    })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: "test-results/archived-history.png",
    animations: "disabled",
  });
  await page
    .getByRole("link", { name: "Monitors", exact: true })
    .first()
    .click();
  await page.getByLabel("Search monitors").fill("gateway");
  await expect(page.getByRole("table").getByRole("row")).toHaveCount(2);
  await page.getByLabel("Search monitors").fill("");
  await page
    .getByRole("button", { name: "Add monitor", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({
    path: "test-results/create-dark.png",
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Add monitor", exact: true }).first(),
  ).toBeFocused();
  await page
    .getByRole("button", { name: "Add monitor", exact: true })
    .first()
    .click();
  await page
    .getByLabel("Hostname", { exact: true })
    .fill("browser.example.test");
  await page.getByLabel("Display name").fill("Browser-created monitor");
  for (const resolver of ["Cloudflare", "Google", "Quad9"])
    await page.getByRole("checkbox", { name: resolver }).uncheck();
  await page.getByRole("button", { name: "Add custom resolver" }).click();
  await page.getByLabel("IP address", { exact: true }).fill("127.0.0.1");
  await page.getByLabel("Port", { exact: true }).fill("15354");
  await page.getByLabel("Check interval").fill("30");
  await page.getByLabel("Confirm a change").fill("1");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add monitor", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Browser-created monitor" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(
    page.getByRole("cell", { name: "Custom 1", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "Edit timing" }).click();
  await page.getByLabel("Check interval").fill("17");
  await page.getByLabel("Failures before alert").fill("3");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Every 17 sec")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/monitor-details.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Resume", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Incidents", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Incidents", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Acknowledge", exact: true })
    .first()
    .click();
  await expect(page.locator(".badge.acknowledged").first()).toBeVisible();
  await page.getByRole("link", { name: "Notifications", exact: true }).click();
  await page
    .getByRole("button", { name: "Add channel", exact: true })
    .first()
    .click();
  await page.getByLabel("Channel name").fill("Browser test receiver");
  await page.getByLabel("Webhook URL").fill("http://127.0.0.1:14001/hook");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add channel", exact: true })
    .click();
  await expect(
    page.getByText("Browser test receiver", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Send test" }).click();
  await expect(page.getByRole("status")).toHaveText("Test notification sent.");
  await page.getByRole("button", { name: "Add rule", exact: true }).click();
  await page.getByLabel("Rule name").fill("Browser alert rule");
  await page.getByRole("checkbox", { name: "Browser test receiver" }).check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add rule", exact: true })
    .click();
  await expect(
    page.getByText("Browser alert rule", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/notifications-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Light theme", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Monitors", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Monitors", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/monitors-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Add monitor", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot({
    path: "test-results/create-mobile.png",
    fullPage: false,
    animations: "disabled",
  });
  await page
    .getByLabel("Hostname", { exact: true })
    .fill("expected-browser.example.test");
  await page.getByLabel("Display name").fill("Mobile expected monitor");
  await page.getByRole("radio", { name: /Match expected values/ }).check();
  await page.getByLabel("Expected records").fill("192.0.2.99");
  for (const resolver of ["Cloudflare", "Google", "Quad9"])
    await page.getByRole("checkbox", { name: resolver }).uncheck();
  await page.getByRole("button", { name: "Add custom resolver" }).click();
  await page.getByLabel("IP address", { exact: true }).fill("127.0.0.1");
  await page.getByLabel("Port", { exact: true }).fill("15354");
  await page.getByLabel("Failures before alert").fill("1");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Add monitor", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Mobile expected monitor" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.locator(".monitor-meta .badge.critical")).toBeVisible({
    timeout: 15000,
  });
  await expect(page.locator(".check-block.critical")).toHaveCount(1);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Edit monitor", exact: true }).click();
  await expect(page.getByLabel("Hostname", { exact: true })).toHaveValue(
    "expected-browser.example.test",
  );
  await expect(page.getByLabel("Port", { exact: true })).toHaveValue("15354");
  await page.getByLabel("Display name").fill("Edited mail monitor");
  await page
    .getByLabel("Hostname", { exact: true })
    .fill("mail-browser.example.test");
  await page.getByLabel("Record type").selectOption("MX");
  await page.getByLabel("Expected records").fill("10 mail.example.test");
  await page.screenshot({
    path: "test-results/edit-monitor-mobile.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Save monitor", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Edited mail monitor" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check now" }).click();
  await expect(page.locator(".monitor-meta .badge.healthy")).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole("link", { name: "Incidents", exact: true }).click();
  await expect(
    page.getByText("Closed after configuration change", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Edited mail monitor", exact: true })
    .click();
  // Another operator changes timing while this form holds a snapshot.
  await page.getByRole("button", { name: "Edit monitor", exact: true }).click();
  const session = await (await page.request.get("/api/v1/auth/session")).json();
  const monitorId = page.url().split("/monitors/")[1]!;
  const concurrent = await page.request.patch(`/api/v1/monitors/${monitorId}`, {
    headers: { "x-csrf-token": session.csrfToken },
    data: { intervalSeconds: 301 },
  });
  expect(concurrent.status()).toBe(204);
  await page.getByRole("button", { name: "Save monitor", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Monitor changed. Reload it before saving or deleting.",
  );
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.reload();
  await page
    .getByRole("button", { name: "Delete monitor", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Delete permanently" }),
  ).toBeDisabled();
  await page.getByLabel("Monitor name to confirm").fill("wrong name");
  await expect(
    page.getByRole("button", { name: "Delete permanently" }),
  ).toBeDisabled();
  await page.getByLabel("Monitor name to confirm").fill("Edited mail monitor");
  await page.screenshot({
    path: "test-results/delete-monitor-mobile.png",
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(
    page.getByRole("heading", { name: "Monitors", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search monitors").fill("Edited mail monitor");
  await expect(
    page.getByRole("heading", { name: "No matching monitors" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome back" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "System theme", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveClass("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass("dark");
  expect(errors).toEqual([]);
});


test("system health shows live data, mobile layout and stale errors", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email address").fill("admin@example.test");
  await page.getByLabel("Password", { exact: true }).fill("browser-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("link", { name: "System health", exact: true }).click();
  await expect(page.getByRole("heading", { name: "System health", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Scheduling and DNS" })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Dark theme", exact: true }).click();
  await page.screenshot({ path: "test-results/system-dark.png", fullPage: true, animations: "disabled" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Light theme", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Storage and retention" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/system-mobile.png", fullPage: true, animations: "disabled" });
  await page.route("**/api/v1/operations", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Unavailable" }) }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Last known status" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("Could not refresh system health");
  await page.unroute("**/api/v1/operations");
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Last known status" })).toHaveCount(0);
});
