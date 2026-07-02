import express from 'express';
import { chromium } from 'playwright';

const app = express();
const PORT = 7654;

let browser;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'q is required' });

  try {
    const b = await getBrowser();
    const page = await b.newPage();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8' });

    await page.goto(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=ja&cc=JP&count=10`,
      { waitUntil: 'domcontentloaded', timeout: 20000 }
    );
    // #b_results is visibility:hidden until Bing's per-result stylesheets finish
    // loading, so the default (visible-state) waitForSelector always timed out.
    // Wait for the item itself to be attached to the DOM instead — visibility
    // doesn't matter for scraping text out of it.
    await page.waitForSelector('#b_results .b_algo', { state: 'attached', timeout: 10000 }).catch(() => {});

    const results = await page.evaluate(() => {
      // textContent, not innerText: innerText returns '' for elements under a
      // visibility:hidden ancestor (#b_results), even though the real text is
      // present in the DOM.
      return [...document.querySelectorAll('#b_results .b_algo')].slice(0, 10).map(el => ({
        title: el.querySelector('h2')?.textContent?.trim() ?? '',
        snippet: el.querySelector('.b_caption p, .b_algoSlug')?.textContent?.trim() ?? '',
        url: el.querySelector('h2 a')?.href ?? '',
      })).filter(r => r.title && r.url);
    });

    await page.close();
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/fetch', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    const b = await getBrowser();
    const page = await b.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const text = await page.evaluate(() => document.body.innerText.slice(0, 4000));
    await page.close();
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Search API running on port ${PORT}`);
});
