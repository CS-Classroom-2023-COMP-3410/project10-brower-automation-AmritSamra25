const puppeteer = require("puppeteer");
const fs = require("fs");

// Load the credentials from the 'credentials.json' file
const credentials = JSON.parse(fs.readFileSync("credentials.json", "utf8"));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const selector = 'form[action*="/star"] button, form[action*="/unstar"] button';

  await page.waitForSelector(selector, { visible: true });

  const starButton = await page.$('form[action*="/star"] button');

  if (starButton) {
    await starButton.evaluate((btn) => btn.scrollIntoView());
    await starButton.click();
    await sleep(1000);
  }
}

async function addRepoToList(page, listName) {
  const dropdownSummary = "details#star-button > summary";

  await page.waitForSelector(dropdownSummary);
  await page.click(dropdownSummary);

  await page.waitForSelector("details#star-button details-menu");
  await sleep(600);

  const lists = await page.$$(".js-user-list-menu-form");

  for (const list of lists) {
    const text = await list.evaluate((n) => n.innerText || "");
    if (text.includes(listName)) {
      const checkbox = await list.$('input[type="checkbox"]');

      if (checkbox) {
        const checked = await checkbox.evaluate((n) => n.checked);
        if (!checked) await checkbox.click();
      } else {
        await list.click();
      }

      break;
    }
  }

  await sleep(800);

  await page.click(dropdownSummary);
}

(async () => {

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null
  });

  const page = await browser.newPage();

  await page.goto("https://github.com/login", { waitUntil: "networkidle2" });

  await page.waitForSelector("#login_field");
  await page.type("#login_field", credentials.username, { delay: 30 });
  await page.type("#password", credentials.password, { delay: 30 });

  await Promise.all([
    page.click('input[name="commit"]'),
    page.waitForNavigation({ waitUntil: "networkidle2" })
  ]);

  await page.waitForSelector(".avatar.circle");

  const actualUsername = await page.$eval(
    'meta[name="octolytics-actor-login"]',
    (meta) => meta.content
  );

  const repositories = [
    "cheeriojs/cheerio",
    "axios/axios",
    "puppeteer/puppeteer"
  ];

  for (const repo of repositories) {
    await page.goto(`https://github.com/${repo}`, { waitUntil: "networkidle2" });

    await ensureStarred(page);

    await sleep(1200);
  }

  await page.goto(`https://github.com/stars/${actualUsername}/lists`, {
    waitUntil: "networkidle2"
  });

  const createListLink =
    (await page.$('a[href*="/lists/new"]')) ||
    (await page.$('a[href*="/stars/"][href*="/lists/new"]'));

  if (createListLink) {
    await Promise.all([
      createListLink.click(),
      page.waitForNavigation({ waitUntil: "networkidle2" })
    ]);
  } else {
    const clicked = await clickByText(page, "a, button", "Create list");
    if (clicked) {
      await page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {});
    }
  }

  await page.waitForSelector('input[name="user_list[name]"], #user_list_name');

  const nameSelector =
    (await page.$("#user_list_name"))
      ? "#user_list_name"
      : 'input[name="user_list[name]"]';

  await page.click(nameSelector, { clickCount: 3 });
  await page.type(nameSelector, "Node Libraries", { delay: 25 });

  await sleep(1000);

  const buttons = await page.$$(".Button--primary.Button--medium.Button, button[type='submit']");

  for (const button of buttons) {
    const buttonText = await button.evaluate((node) => node.textContent.trim());

    if (buttonText === "Create" || buttonText === "Create list") {
      await Promise.all([
        button.click(),
        page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {})
      ]);
      break;
    }
  }

  await sleep(1500);

  for (const repo of repositories) {
    await page.goto(`https://github.com/${repo}`, { waitUntil: "networkidle2" });

    await ensureStarred(page);

    await addRepoToList(page, "Node Libraries");
  }

  await browser.close();

})();