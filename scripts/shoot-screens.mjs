import { chromium } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";

const URL = "http://localhost:1420/";
const OUT = "/tmp/shots-screens";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 880 }, deviceScaleFactor: 2 });
await page.goto(URL, { waitUntil: "networkidle" });
await sleep(1500);

// Default theme = mono dark (the design hero) for the screen tour
await page.evaluate(() => {
  document.documentElement.setAttribute("data-tnd-theme", "mono");
  document.documentElement.setAttribute("data-tnd-mode", "dark");
});
await sleep(600);

async function clickText(t) {
  const el = page.locator(`text="${t}"`).first();
  if (await el.count()) { await el.click(); await sleep(700); return true; }
  return false;
}

// Calendar
await clickText("Calendar");
await page.screenshot({ path: `${OUT}/calendar.png` });
// Tags
await clickText("Tags");
await page.screenshot({ path: `${OUT}/tags.png` });
// Plugins
await clickText("Plugins");
await page.screenshot({ path: `${OUT}/plugins.png` });
// Settings (gear) — open via keyboard cmd+,  then screenshot
await page.keyboard.press("Meta+Comma");
await sleep(700);
await page.screenshot({ path: `${OUT}/settings.png` });
// Search overlay (cmd+p)
await page.keyboard.press("Meta+p");
await sleep(700);
await page.screenshot({ path: `${OUT}/search.png` });
await page.keyboard.press("Escape");
// Command palette (cmd+k)
await page.keyboard.press("Meta+k");
await sleep(700);
await page.screenshot({ path: `${OUT}/palette.png` });

await browser.close();
console.log("screen shots →", OUT);
