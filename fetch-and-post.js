// fetch-and-post.js
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const puppeteer = require('puppeteer');

// 👇 Metti qui gli URL da monitorare (Ticketmaster, TicketOne, Vivaticket)
const urls = [
  { url: "https://www.ticketmaster.it/...", label: "Ticketmaster IT – data X" },
  { url: "https://www.ticketone.it/...",    label: "TicketOne – data X" },
  { url: "https://www.vivaticket.com/...",  label: "Vivaticket – data X" }
];

async function run() {
  const webhook = process.env.N8N_WEBHOOK;             // es: https://xxx.n8n.cloud/webhook/weeknd/html
  const authHdr = process.env.N8N_WEBHOOK_AUTH || "";  // opzionale: se hai messo un header segreto sul webhook

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox","--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();

  // user-agent e lingua "umani"
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({ "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7" });

  for (const item of urls) {
    try {
      await page.goto(item.url, { waitUntil: "networkidle2", timeout: 120000 });
      // attesa extra per contenuti caricati via JS
      await page.waitForTimeout(1500);
      const html = await page.content();

      const res = await fetch(webhook, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authHdr ? { "X-Auth": authHdr } : {})
        },
        body: JSON.stringify({
          url: item.url,
          label: item.label,
          html
          // se vuoi passare il chatId direttamente da qui: chatId: 123456789
        })
      });

      console.log("Posted:", item.label, res.status);
    } catch (e) {
      console.error("Error on", item.url, e.message);
    }
  }

  await browser.close();
}

run();
