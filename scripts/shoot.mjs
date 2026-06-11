import { chromium } from "playwright";
import { setTimeout as sleep } from "node:timers/promises";

const URL = process.env.SHOOT_URL || "http://localhost:1420/";
const OUT = process.env.SHOOT_OUT || "/tmp/shots-built";
const themes = ["paper", "fog", "mono", "editorial", "soft"];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 880 }, deviceScaleFactor: 2 });
await page.goto(URL, { waitUntil: "networkidle" });
await sleep(1200); // fonts + mock load

for (const theme of themes) {
  await page.evaluate((t) => {
    document.documentElement.setAttribute("data-tnd-theme", t);
    document.documentElement.setAttribute("data-tnd-mode", "light");
  }, theme);
  await sleep(700);
  await page.screenshot({ path: `${OUT}/${theme}-light.png` });
}
// one dark sample (mono dark = the design's hero)
await page.evaluate(() => document.documentElement.setAttribute("data-tnd-mode", "dark"));
await page.evaluate(() => document.documentElement.setAttribute("data-tnd-theme", "mono"));
await sleep(700);
await page.screenshot({ path: `${OUT}/mono-dark.png` });

await browser.close();
console.log("shots written to", OUT);
