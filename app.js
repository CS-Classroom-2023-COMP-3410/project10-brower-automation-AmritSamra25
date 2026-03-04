const puppeteer = require("puppeteer");
const fs = require("fs");

const credentials = JSON.parse(fs.readFileSync("credentials.json", "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitVisible(page, selector, timeout = 30000) {
  await page.waitForSelector(selector, { visible: true, timeout });
}

async function clickIfExists(page, selector) {
  const el = await page.$(selector);
  if (!el) return false;
  await el.evaluate((n) => n.scrollIntoView({ block: "center" }));
  await el.click();
  return true;
}

async function clickByText(page, selectors, text) {
  const sel = Array.isArray(selectors) ? selectors.join(",") : selectors;
  await page.waitForSelector(sel);
  const els = await page.$$(sel);
  for (const el of els) {
    const t = await el.evaluate((n) => (n.textContent || "").trim());
    if (t === text) {
      await el.evaluate((n) => n.scrollIntoView({ block: "center" }));
      await el.click();
      return true;
    }
  }
  return false;
}

async function ensureLoggedIn(page) {
  // if already logged in, avatar exists
  const avatar = await page.$(".avatar.circle, img.avatar");
  if (avatar) return;

  await page.goto("https://github.com/login", { waitUntil: "domcontentloaded" });
  await waitVisible(page, "#login_field");
  await page.type("#login_field", credentials.username, { delay: 25 });
  await page.type("#password", credentials.password, { delay: 25 });

  await Promise.all([
    page.click('input[name="commit"]'),
    page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}),
  ]);

  // If GitHub asks for 2FA, let you do it manually.
  // We just wait until we see an avatar somewhere after you finish.
  for (let i = 0; i < 120; i++) {
    const ok = await page.$(".avatar.circle, img.avatar");
    if (ok) return;
    await sleep(500);
  }

  throw new Error("Login did not complete (possible 2FA / verification screen).");
}

async function ensureStarred(page) {
  // Prefer the stable GitHub form actions (when present)
  const starFormBtn = 'form[action*="/star"] button';
  const unstarFormBtn = 'form[action*="/unstar"] button';

  // Wait for *either* star/unstar UI to show up
  await page.waitForSelector(
    `${starFormBtn}, ${unstarFormBtn}, button[aria-label*="Star"], button[aria-label*="Unstar"]`,
    { timeout: 30000 }
  );

  // Already starred?
  if (await page.$(unstarFormBtn)) return;

  // Click the "Star" button (form-based)
  const starBtn = await page.$(starFormBtn);
  if (starBtn) {
    await starBtn.evaluate((n) => n.scrollIntoView({ block: "center" }));
    await starBtn.click();
    // wait until it becomes unstar
    await page.waitForSelector(unstarFormBtn, { timeout: 30000 });
    return;
  }

  // Fallback: aria-label buttons
  // Find a button that stars (not unstars)
  const ariaButtons = await page.$$(
    'button[aria-label*="Star"], button[aria-label*="Unstar"]'
  );

  for (const b of ariaButtons) {
    const label = await b.evaluate((n) => n.getAttribute("aria-label") || "");
    if (label.toLowerCase().includes("unstar")) return; // already starred
  }

  for (const b of ariaButtons) {
    const label = await b.evaluate((n) => n.getAttribute("aria-label") || "");
    if (label.toLowerCase().includes("star")) {
      await b.evaluate((n) => n.scrollIntoView({ block: "center" }));
      await b.click();
      // give GitHub time to process
      await sleep(800);
      return;
    }
  }
}

async function gotoStarsAndLists(page) {
  // Don’t hardcode /stars/<user>/lists — GitHub can 404 that route.
  await page.goto("https://github.com/stars", { waitUntil: "domcontentloaded" });
  await ensureLoggedIn(page);

  // Click the Lists link in the stars UI
  // Try a few common hrefs GitHub uses.
  const candidates = [
    'a[href="/stars?tab=lists"]',
    'a[href$="?tab=lists"]',
    'a[href$="/lists"]',
    'a[data-ga-click*="Lists"]',
  ];

  for (const sel of candidates) {
    const ok = await clickIfExists(page, sel);
    if (ok) {
      await page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {});
      return;
    }
  }

  // Fallback: click by text
  const clicked = await clickByText(page, ["a", "button"], "Lists");
  if (clicked) {
    await page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {});
    return;
  }

  // If this fails, GitHub UI changed; but the rest still can run (just list steps won’t).
  throw new Error("Could not navigate to Lists from the Stars page.");
}

async function ensureListExists(page, listName) {
  // We should be on the Lists page already.
  await sleep(500);

  // If the list already exists, open it and return
  const listLinks = await page.$$("a");
  for (const a of listLinks) {
    const t = await a.evaluate((n) => (n.textContent || "").trim());
    if (t === listName) {
      await a.evaluate((n) => n.scrollIntoView({ block: "center" }));
      await a.click();
      await page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {});
      return;
    }
  }

  // Create list
  // GitHub sometimes uses "Create list" as a button or link.
  const createSelectors = [
    'a[href*="lists/new"]',
    'button:has-text("Create list")', // not supported in puppeteer, kept for clarity
  ];

  // Try link first
  if (!(await clickIfExists(page, 'a[href*="lists/new"]'))) {
    // Fallback by text
    const ok = await clickByText(page, ["a", "button"], "Create list");
    if (!ok) throw new Error('Could not find "Create list" control.');
  }

  await page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {});

  // Fill name + submit
  const nameSel =
    (await page.$("#user_list_name")) ? "#user_list_name" : 'input[name="user_list[name]"]';

  await waitVisible(page, nameSel);
  await page.click(nameSel, { clickCount: 3 });
  await page.type(nameSel, listName, { delay: 20 });

  // Submit
  // Try common submit buttons
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    ".Button--primary",
  ];

  let submitted = false;
  for (const sel of submitSelectors) {
    const btns = await page.$$(sel);
    for (const btn of btns) {
      const text = await btn.evaluate((n) => (n.textContent || n.value || "").trim());
      if (
        text === "Create" ||
        text === "Create list" ||
        text.toLowerCase().includes("create")
      ) {
        await btn.evaluate((n) => n.scrollIntoView({ block: "center" }));
        await btn.click();
        submitted = true;
        break;
      }
    }
    if (submitted) break;
  }

  if (!submitted) throw new Error("Could not submit list creation form.");

  await page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {});
}

async function addRepoToList(page, listName) {
  // Must be on a repo page and starred.
  // Open the star dropdown; GitHub uses details#star-button in many layouts.
  const dropdownSelectors = [
    "details#star-button > summary",
    'details[id="star-button"] > summary',
    'summary[aria-label*="Star"]',
    'summary[aria-label*="Starred"]',
  ];

  let opened = false;
  for (const sel of dropdownSelectors) {
    const ok = await clickIfExists(page, sel);
    if (ok) {
      opened = true;
      break;
    }
  }

  if (!opened) {
    // Some layouts have a small caret next to "Starred"
    const caretClicked = await clickIfExists(page, 'button[aria-label*="Starred"]');
    if (!caretClicked) throw new Error("Could not open star/list dropdown on repo page.");
  }

  await sleep(600);

  // Now find the list checkbox item
  // GitHub usually renders list rows with .js-user-list-menu-form
  await page.waitForSelector(".js-user-list-menu-form, details-menu", { timeout: 15000 }).catch(() => {});
  const rows = await page.$$(".js-user-list-menu-form");

  if (!rows.length) {
    // Fallback: any label/row containing the list name
    const any = await page.$$("label, div, form");
    for (const el of any) {
      const t = await el.evaluate((n) => (n.innerText || "").trim());
      if (t.includes(listName)) {
        // try checkbox inside
        const cb = await el.$('input[type="checkbox"]');
        if (cb) {
          const checked = await cb.evaluate((n) => n.checked);
          if (!checked) await cb.click();
        } else {
          await el.click();
        }
        await sleep(600);
        return;
      }
    }
    throw new Error(`Could not find list "${listName}" in dropdown.`);
  }

  for (const row of rows) {
    const t = await row.evaluate((n) => (n.innerText || "").trim());
    if (t.includes(listName)) {
      const cb = await row.$('input[type="checkbox"]');
      if (cb) {
        const checked = await cb.evaluate((n) => n.checked);
        if (!checked) await cb.click();
      } else {
        await row.click();
      }
      await sleep(600);
      return;
    }
  }

  throw new Error(`List "${listName}" not found in dropdown rows.`);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
  });

  const page = await browser.newPage();

  await ensureLoggedIn(page);

  const repositories = [
    "cheeriojs/cheerio",
    "axios/axios",
    "puppeteer/puppeteer",
  ];

  // Star all three
  for (const repo of repositories) {
    await page.goto(`https://github.com/${repo}`, { waitUntil: "domcontentloaded" });
    await ensureStarred(page);
    await sleep(1200);
  }

  // Go to Stars -> Lists via UI (avoids 404 routing issues)
  await gotoStarsAndLists(page);

  // Create/open "Node Libraries"
  const listName = "Node Libraries";
  await ensureListExists(page, listName);

  // Add each repo to the list
  for (const repo of repositories) {
    await page.goto(`https://github.com/${repo}`, { waitUntil: "domcontentloaded" });
    await ensureStarred(page); // safety
    await addRepoToList(page, listName);
    await sleep(1000);
  }

  // Optional: keep browser open a bit so you can see results
  await sleep(1500);

  await browser.close();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});