const puppeteer = require("puppeteer");
const fs = require("fs");

const credentials = JSON.parse(fs.readFileSync("credentials.json", "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitVisible(page, selector, timeout = 30000) {
  await page.waitForSelector(selector, { visible: true, timeout });
}

async function clickIfExists(page, selector) {
  try {
    const el = await page.$(selector);
    if (!el) return false;
    await el.evaluate((n) => n.scrollIntoView({ block: "center" }));
    await el.click();
    return true;
  } catch {
    return false;
  }
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

  for (let i = 0; i < 120; i++) {
    const ok = await page.$(".avatar.circle, img.avatar");
    if (ok) {
      console.log("Logged in successfully.");
      return;
    }
    await sleep(500);
  }

  throw new Error("Login did not complete (possible 2FA / verification screen).");
}

async function ensureStarred(page) {
  const starFormBtn = 'form[action*="/star"] button';
  const unstarFormBtn = 'form[action*="/unstar"] button';

  await page.waitForSelector(
    `${starFormBtn}, ${unstarFormBtn}, button[aria-label*="Star"], button[aria-label*="Unstar"]`,
    { timeout: 30000 }
  );

  if (await page.$(unstarFormBtn)) {
    console.log("  Already starred.");
    return;
  }

  const starBtn = await page.$(starFormBtn);
  if (starBtn) {
    await starBtn.evaluate((n) => n.scrollIntoView({ block: "center" }));
    await starBtn.click();
    await page.waitForSelector(unstarFormBtn, { timeout: 30000 });
    console.log("  Starred via form button.");
    return;
  }

  const ariaButtons = await page.$$(
    'button[aria-label*="Star"], button[aria-label*="Unstar"]'
  );

  for (const b of ariaButtons) {
    const label = await b.evaluate((n) => n.getAttribute("aria-label") || "");
    if (label.toLowerCase().includes("unstar")) {
      console.log("  Already starred (aria).");
      return;
    }
  }

  for (const b of ariaButtons) {
    const label = await b.evaluate((n) => n.getAttribute("aria-label") || "");
    if (label.toLowerCase().includes("star")) {
      await b.evaluate((n) => n.scrollIntoView({ block: "center" }));
      await b.click();
      await sleep(800);
      console.log("  Starred via aria button.");
      return;
    }
  }

  throw new Error("Could not find a Star button on this page.");
}

// Creates the list if it doesn't exist. Does NOT navigate into it.
async function ensureListCreated(page, listName) {
  await page.goto("https://github.com/stars", { waitUntil: "domcontentloaded" });
  await sleep(1000);

  // Try to get to the Lists tab
  const candidates = [
    'a[href="/stars?tab=lists"]',
    'a[href$="?tab=lists"]',
    'a[href$="/lists"]',
    'a[data-ga-click*="Lists"]',
  ];

  let onListsTab = false;
  for (const sel of candidates) {
    const ok = await clickIfExists(page, sel);
    if (ok) {
      await page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {});
      onListsTab = true;
      console.log("Navigated to Lists tab.");
      break;
    }
  }

  if (!onListsTab) {
    const clicked = await clickByText(page, ["a", "button"], "Lists");
    if (clicked) {
      await page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {});
      console.log("Navigated to Lists tab (text fallback).");
    } else {
      throw new Error("Could not navigate to Lists tab.");
    }
  }

  await sleep(500);

  // Check if the list already exists by scanning all link text
  const allLinks = await page.$$("a");
  for (const a of allLinks) {
    const t = await a.evaluate((n) => (n.textContent || "").trim());
    if (t === listName) {
      console.log(`List "${listName}" already exists, skipping creation.`);
      return;
    }
  }

  // Click "Create list"
  const createdViaLink = await clickIfExists(page, 'a[href*="lists/new"]');
  if (!createdViaLink) {
    const ok = await clickByText(page, ["a", "button"], "Create list");
    if (!ok) throw new Error('Could not find "Create list" control.');
  }

  await page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {});

  // Fill in the list name
  const nameSel = (await page.$("#user_list_name"))
    ? "#user_list_name"
    : 'input[name="user_list[name]"]';

  await waitVisible(page, nameSel);
  await page.click(nameSel, { clickCount: 3 });
  await page.type(nameSel, listName, { delay: 20 });

  // Submit
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
      if (text.toLowerCase().includes("create")) {
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
  console.log(`List "${listName}" created.`);
}

async function addRepoToList(page, listName) {
  // Must already be on the repo page and starred.
  // Open the dropdown next to the Starred button.
  await sleep(500);

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
      console.log(`  Opened dropdown via: ${sel}`);
      break;
    }
  }

  if (!opened) {
    const caretClicked = await clickIfExists(page, 'button[aria-label*="Starred"]');
    if (!caretClicked) throw new Error("Could not open star/list dropdown on repo page.");
    opened = true;
    console.log("  Opened dropdown via Starred button.");
  }

  // Give the dropdown time to render
  await sleep(1500);

  // Wait for the list menu to appear
  await page
    .waitForSelector(".js-user-list-menu-form, details-menu, [data-target='user-list-channel.listForm']", { timeout: 15000 })
    .catch(() => {
      console.log("  Warning: could not confirm dropdown rendered, trying anyway...");
    });

  // Try the standard .js-user-list-menu-form rows first
  const rows = await page.$$(".js-user-list-menu-form");
  console.log(`  Found ${rows.length} list rows in dropdown.`);

  if (rows.length) {
    for (const row of rows) {
      const t = await row.evaluate((n) => (n.innerText || "").trim());
      if (t.includes(listName)) {
        const cb = await row.$('input[type="checkbox"]');
        if (cb) {
          const checked = await cb.evaluate((n) => n.checked);
          if (!checked) {
            await cb.click();
            console.log(`  Added to "${listName}".`);
          } else {
            console.log(`  Already in "${listName}".`);
          }
        } else {
          await row.click();
          console.log(`  Clicked row for "${listName}".`);
        }
        await sleep(800);
        return;
      }
    }
  }

  // Fallback: scan all labels and divs for the list name
  const elements = await page.$$("label, li, div[role='menuitem']");
  for (const el of elements) {
    const t = await el.evaluate((n) => (n.innerText || "").trim());
    if (t.includes(listName)) {
      const cb = await el.$('input[type="checkbox"]');
      if (cb) {
        const checked = await cb.evaluate((n) => n.checked);
        if (!checked) await cb.click();
        console.log(`  Added to "${listName}" (fallback label).`);
      } else {
        await el.click();
        console.log(`  Clicked element for "${listName}" (fallback).`);
      }
      await sleep(800);
      return;
    }
  }

  throw new Error(`List "${listName}" not found in dropdown. Make sure the list was created and the repo is starred.`);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
  });

  const page = await browser.newPage();

  console.log("Logging in...");
  await ensureLoggedIn(page);

  const repositories = [
    "cheeriojs/cheerio",
    "axios/axios",
    "puppeteer/puppeteer",
  ];

  // Step 1: Star all three repositories
  console.log("\nStarring repositories...");
  for (const repo of repositories) {
    console.log(`  -> ${repo}`);
    await page.goto(`https://github.com/${repo}`, { waitUntil: "domcontentloaded" });
    await ensureStarred(page);
    await sleep(1200);
  }

  // Step 2: Create the list (navigate to stars/lists, create if needed)
  const listName = "Node Libraries";
  console.log(`\nEnsuring list "${listName}" exists...`);
  await ensureListCreated(page, listName);

  // Step 3: Go to each repo and add it to the list via the star dropdown
  console.log(`\nAdding repos to "${listName}"...`);
  for (const repo of repositories) {
    console.log(`  -> ${repo}`);
    await page.goto(`https://github.com/${repo}`, { waitUntil: "domcontentloaded" });
    await ensureStarred(page);
    await addRepoToList(page, listName);
    await sleep(1000);
  }

  console.log("\nAll done!");
  await sleep(2000);
  await browser.close();
})().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});