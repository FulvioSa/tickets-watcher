import { chromium } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fetch from "node-fetch";

const WEBHOOK_URL = process.env.WEBHOOK_URL;               // secret
const CHAT_ID = process.env.CHAT_ID ? Number(process.env.CHAT_ID) : undefined;

if (!WEBHOOK_URL) {
  console.error("Missing WEBHOOK_URL secret"); process.exit(1);
}

const targets = JSON.parse(await fs.readFile("./urls.json", "utf8"));
let state = {};
try { state = JSON.parse(await fs.readFile("./state.json","utf8")); } catch { state = {}; }

// parole chiave che il tuo parser n8n capisce già
const sectorKeywords = ["gold circle","golden circle","prato gold","inner circle"];
const qtyPatterns = [/\b2\s*tickets?\b/i, /\b2x\b/i, /\bcoppia\b/i, /\b2\s*bigliett/i];
// segnali di sold-out/disponibilità generica (solo pre-filtro, la decisione finale la fa n8n)
const negative = ['sold out','currently unavailable','no tickets available','esaurito','esauriti','not available'];
const positive = ['buy tickets','find tickets','resale','tickets available','acquista','disponibili','available now'];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const gotoOpts = { waitUntil: "domcontentloaded", timeout: 60_000 };

function sha(str){ return crypto.createHash("sha256").update(str).digest("hex"); }

function preCheck(text){
  const t = text.toLowerCase();
  const hasGold = sectorKeywords.some(k => t.includes(k));
  const hasQty2  = qtyPatterns.some(re => re.test(t));
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

    // prova a chiudere banner cookie comuni (best-effort)
    const cookieSelectors = [
      'button#onetrust-accept-btn-handler',
      'button:has-text("Accetta")',
      'button:has-text("Accetto")',
      '[data-accept]','[aria-label*="Accetta"]'
    ];
    for (const sel of cookieSelectors){
      const e = page.locator(sel).first();
      if (await e.count()) { await e.click({timeout: 1500}).catch(()=>{}); break; }
    }

    // scroll corto per innescare lazy load
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight/3));
    await page.waitForTimeout(800);

    const html = await page.content();
    const text = await page.evaluate(() => document.body.innerText || "");

    // dedup: se né html né testo cambiano, e non c'è segnale "positivo", salta POST
    const sig = sha(html);
    const prevSig = state[t.url]?.sig;
    const mini = preCheck(text);

    // se è identico e non ci sono keyword interessanti → salta
    if (prevSig === sig && !(mini.hasGold || mini.pos)) {
      console.log(`No change & no signal: ${t.url}`);
      return { posted:false, reason:"nochange" };
    }

    // POST al webhook (il parsing vero lo fa n8n)
    const payload = {
      url: t.url,
      label: t.label || t.url,
      chatId: CHAT_ID,
      html,
      // opzionale: passiamo anche keywords così n8n potrebbe usarle
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
  // salva sempre lo stato (per dedup)
  await fs.writeFile("./state.json", JSON.stringify(state, null, 2));
  process.exit(ok ? 0 : 1);
})();
