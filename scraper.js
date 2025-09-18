// scraper.js
import { chromium } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fetch from "node-fetch";
import path from "node:path";

const WEBHOOK_URL = process.env.WEBHOOK_URL; // impostalo come secret
const CHAT_ID = process.env.CHAT_ID ? Number(process.env.CHAT_ID) : undefined;

if (!WEBHOOK_URL) {
  console.error("Missing WEBHOOK_URL secret"); process.exit(1);
}

const targets = JSON.parse(await fs.readFile("./urls.json", "utf8"));
let state = {};
try { state = JSON.parse(await fs.readFile("./state.json","utf8")); } catch { state = {}; }

// keywords / regex (coerenti con n8n)
const sectorKeywords = ["gold circle","golden circle","prato gold","inner circle"];
const qtyPatterns = [/\b2\s*tickets?\b/i, /\b2x\b/i, /\bcoppia\b/i, /\b2\s*bigliett/i];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const gotoOpts = { waitUntil: "domcontentloaded", timeout: 60_000 };

function sha(str){ return crypto.createHash("sha256").update(str).digest("hex"); }

function preCheck(text){
  const t = text.toLowerCase();
  const hasGold = sectorKeywords.some(k => t.includes(k));
  const hasQty2  = qtyPatterns.some(re => re.test(t));
  const positive = ['buy tickets','find tickets','resale','tickets available','acquista','disponibili','available now'];
  const negative = ['sold out','currently unavailable','no tickets available','esaurito','esauriti','not available'];
  const pos = positive.some(k => t.includes(k));
  const neg = negative.some(k => t.includes(k));
  return { hasGold, hasQty2, pos, neg };
}

async function scrapeOne(browser, t){
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 900 },
    locale: "it-IT"
  });
  const page = await ctx.newPage();

  try {
    await page.goto(t.url, gotoOpts);

    // best-effort close cookie banner
    const cookieSelectors = [
      'button#onetrust-accept-btn-handler',
      'button:has-text("Accetta")',
      'button:has-text("Accetto")',
      '[data-accept]','[aria-label*="Accetta"]'
    ];
    for (const sel of cookieSelectors){
      try {
        const el = page.locator(sel).first();
        if (await el.count()) { await el.click({timeout: 1500}).catch(()=>{}); break; }
      } catch(e){}
    }

    // scroll per lazy load e stabilizzare
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight/3));
    await page.waitForTimeout(800);

    // salva screenshot (file)
    await fs.mkdir('./shots', { recursive: true });
    const safe = t.label ? t.label.replace(/\W+/g,'_').slice(0,40) : 'shot';
    const shotPath = `./shots/${safe}_after.png`;
    await page.screenshot({ path: shotPath, fullPage: true });

    const html = await page.content();
    const text = await page.evaluate(() => document.body.innerText || "");

    // dedup: se segnali non interessanti e nulla è cambiato -> skip
    const sig = sha(html);
    const prevSig = state[t.url]?.sig;
    const mini = preCheck(text);

    if (prevSig === sig && !(mini.hasGold || mini.pos)) {
      console.log(`No change & no signal: ${t.url}`);
      return { posted:false, reason:"nochange" };
    }

    // rilevazione blocco (captcha/imperva)
    const blocked = /imperva|captcha|i'm not a human|additional security check|why am i seeing this page/i.test(text + html.toLowerCase());

    // read screenshot file and convert base64
    const b = await fs.readFile(shotPath);
    const screenshot_b64 = b.toString('base64');

    // POST payload
    const payload = {
      url: t.url,
      label: t.label || t.url,
      chatId: CHAT_ID,
      html,
      text: text.slice(0, 4000), // un estratto opzionale
      blocked,
      detectedProvider: blocked ? 'imperva_or_captcha' : null,
      screenshot_base64: screenshot_b64,
      sectorKeywords,
      qtyPatterns: qtyPatterns.map(re => re.source)
    };

    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const txt = await res.text().catch(()=> "");
      throw new Error(`Webhook POST failed ${res.status} ${txt}`);
    }

    // aggiorna stato
    state[t.url] = { sig, lastPostAt: new Date().toISOString() };
    console.log(`Posted → ${t.label}`);
    return { posted:true };
  } catch (e){
    console.error(`Error ${t.url}:`, e.message);
    return { posted:false, reason:"error" };
  } finally {
    await ctx.close();
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  let ok = true;
  for (const t of targets){
    const r = await scrapeOne(browser, t);
    ok = ok && (r.posted || r.reason === "nochange");
  }
  await browser.close();
  // salva stato (per dedup)
  await fs.writeFile("./state.json", JSON.stringify(state, null, 2));
  process.exit(ok ? 0 : 1);
})();
