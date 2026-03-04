const puppeteer = require("puppeteer");
const fs = require("fs");

// Load the credentials from the 'credentials.json' file
const credentials = JSON.parse(fs.readFileSync("credentials.json", "utf8"));

async function clickByText(page, selector, text) {
  await page.waitForSelector(selector);
  const handles = await page.$$(selector);
  for (const h of handles) {
    const t = await h.evaluate((n) => (n.textContent || "").trim());
    if (t === text) {
      await h.click();
      return true;
    }
  }
  return false;
}

async function ensureStarred(page) {
  // If it's not starred yet, GitHub shows a form posting to /star.
  // If already starred, it shows /unstar.
  await page.waitForSelector('form[action*="/star"] button, form[action*="/unstar"] button');

  const starButton = await page.$('form[action*="/star"] button');
  if (starButton) {
    await starButton.click();
    await page.waitForTimeout(800);
  }
}

async function addRepoToList(page, listName) {
  // Star dropdown lives under details#star-button on repo pages.
  const dropdownSummary = "details#star-button > summary";

  await page.waitForSelector(dropdownSummary);
  await page.click(dropdownSummary);

  // Menu options (lists) load inside details-menu
  await page.waitForSelector("details#star-button details-menu");
  await page.waitForTimeout(500);

  const lists = await page.$$(".js-user-list-menu-form");
  for (const list of lists) {
    const text = await list.evaluate((n) => n.innerText || "");
    if (text.includes(listName)) {
      const checkbox = await list.$('input[type="checkbox"]');
      if (checkbox) {
        // Only click if not already checked
        const checked = await checkbox.evaluate((n) => n.checked);
        if (!checked) await checkbox.click();
      } else {
        // Fallback: clicking the form often toggles it
        await list.click();
      }
      break;
    }
  }

  await page.waitForTimeout(800);

  // Close the dropdown to finalize
  await page.click(dropdownSummary);
}

(async () => {
  // Launch a browser instance and open a new page
  const browser = await puppeteer.launch({
    headless: false, // set true if you want it hidden
    defaultViewport: null,
  });
  const page = await browser.newPage();

  // Navigate to GitHub login page
  await page.goto("https://github.com/login", { waitUntil: "networkidle2" });

  // Login to GitHub using the provided credentials
  await page.waitForSelector("#login_field");
  await page.type("#login_field", credentials.username, { delay: 30 });
  await page.type("#password", credentials.password, { delay: 30 });
  await Promise.all([
    page.click('input[name="commit"]'),
    page.waitForNavigation({ waitUntil: "networkidle2" }),
  ]);

  // Wait for successful login (avatar)
  await page.waitForSelector(".avatar.circle");

  // Extract the actual GitHub username to be used later
  const actualUsername = await page.$eval(
    'meta[name="octolytics-actor-login"]',
    (meta) => meta.content
  );

  const repositories = ["cheeriojs/cheerio", "axios/axios", "puppeteer/puppeteer"];

  for (const repo of repositories) {
    await page.goto(`https://github.com/${repo}`, { waitUntil: "networkidle2" });

    // Star the repository
    await ensureStarred(page);
    await page.waitForTimeout(1000);
  }

  // Navigate to the user's starred repositories lists page
  await page.goto(`https://github.com/stars/${actualUsername}/lists`, {
    waitUntil: "networkidle2",
  });

  // Click on the "Create list" button
  // Try a stable href first, otherwise fall back to clicking by text.
  const createListLink =
    (await page.$('a[href*="/lists/new"]')) ||
    (await page.$('a[href*="/stars/"][href*="/lists/new"]'));

  if (createListLink) {
    await Promise.all([
      createListLink.click(),
      page.waitForNavigation({ waitUntil: "networkidle2" }),
    ]);
  } else {
    const clicked = await clickByText(page, "a, button", "Create list");
    if (clicked) {
      await page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {});
    }
  }

  // Create a list named "Node Libraries"
  await page.waitForSelector('input[name="user_list[name]"], #user_list_name');
  const nameSelector =
    (await page.$("#user_list_name")) ? "#user_list_name" : 'input[name="user_list[name]"]';
  await page.click(nameSelector, { clickCount: 3 });
  await page.type(nameSelector, "Node Libraries", { delay: 25 });

  // Wait for buttons to become visible
  await page.waitForTimeout(1000);

  // Identify and click the "Create" button
  const buttons = await page.$$(".Button--primary.Button--medium.Button, button[type='submit']");
  for (const button of buttons) {
    const buttonText = await button.evaluate((node) => node.textContent.trim());
    if (buttonText === "Create" || buttonText === "Create list") {
      await Promise.all([
        button.click(),
        page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {}),
      ]);
      break;
    }
  }

  // Allow some time for the list creation process
  await page.waitForTimeout(1500);

  for (const repo of repositories) {
    await page.goto(`https://github.com/${repo}`, { waitUntil: "networkidle2" });

    // Add this repository to the "Node Libraries" list
    await ensureStarred(page);
    await addRepoToList(page, "Node Libraries");
  }

  await browser.close();
})();