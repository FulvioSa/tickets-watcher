import { chromium } from "playwright";
import fetch from "node-fetch";
import fs from "fs/promises";

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const CHAT_ID = process.env.CHAT_ID ? Number(process.env.CHAT_ID) : undefined;

if (!WEBHOOK_URL) {
  console.error("Missing WEBHOOK_URL secret");
  process.exit(1);
}

const targets = JSON.parse(await fs.readFile("./urls.json", "utf8"));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const gotoOpts = { waitUntil: "domcontentloaded", timeout: 60_000 };

async function scrapeOne(browser, t) {
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 850 }
  });
  const page = await ctx.newPage();

  try {
    await page.goto(t.url, gotoOpts);

    // Piccole attese per cookie/geo popups comuni
    await page.waitForTimeout(1500);

    // Se appare un banner cookie, prova a chiuderlo (best-effort, non blocca se non c'è)
    const cookieSelectors = ['button:has-text("Accetta")', 'button#onetrust-accept-btn-handler'];
    for (const sel of cookieSelectors) {
      const btn = await page.locator(sel).first();
      if (await btn.count()) { await btn.click().catch(()=>{}); break; }
    }

    // Optional: scroll leggero per far caricare blocchi lazy
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight/3));
    await page.waitForTimeout(800);

    const html = await page.content();

    const payload = {
      url: t.url,
      label: t.label || t.url,
      chatId: CHAT_ID,          // opzionale: se lo passi qui, n8n lo userà
      html
    };

    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const txt = await res.text().catch(()=> "");
      console.error(`Webhook POST failed for ${t.url}: ${res.status} ${txt}`);
      return false;
    }
    console.log(`Posted ${t.url}`);
    return true;
  } catch (err) {
    console.error(`Error scraping ${t.url}`, err.message);
    return false;
  } finally {
    await ctx.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  let ok = true;
  for (const t of targets) {
    const success = await scrapeOne(browser, t);
    ok = ok && success;
  }
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
