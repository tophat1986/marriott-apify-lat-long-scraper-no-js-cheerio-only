// main.js
import { Actor, log } from 'apify';
import { Dataset } from 'crawlee';
import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';

// ------------------------------------------------------------------
// Defaults
// ------------------------------------------------------------------
const DEFAULT_CONCURRENCY = 5;
const DEFAULT_SESSION_PAGES = 10;    // rotate proxy session after N pages
const DEFAULT_TIMEOUT_SECS = 15;     // network timeout per request
const DEFAULT_DELAY_MS_MIN = 250;
const DEFAULT_DELAY_MS_MAX = 750;

// Browser headers
const BASE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.8',
  'Connection': 'keep-alive',
};

// ------------------------------------------------------------------
// Utility
// ------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickHotelNode(jsonBlocks) {
  if (!Array.isArray(jsonBlocks)) return null;
  for (const block of jsonBlocks) {
    const t = block?.['@type'];
    if (t === 'Hotel' || t === 'LodgingBusiness') return block;
    if (Array.isArray(t) && t.includes('Hotel')) return block;
  }
  return null;
}

function extractJsonLd(html) {
  const $ = cheerio.load(html);
  const blocks = [];
  $('script[type="application/ld+json"]').each((i, el) => {
    const txt = $(el).text();
    if (!txt?.trim()) return;
    try {
      const parsed = JSON.parse(txt);
      blocks.push(parsed);
    } catch (err) {
      log.debug(`JSON-LD parse fail idx ${i}: ${err?.message}`);
    }
  });
  return blocks;
}

// ------------------------------------------------------------------
// Fetch one page (single attempt)
// ------------------------------------------------------------------
async function fetchPage({
  url,
  proxyUrl,
  timeoutSecs,
}) {
  try {
    const res = await gotScraping({
      url,
      proxyUrl,
      timeout: { request: timeoutSecs * 1000 },
      throwHttpErrors: false,
      followRedirect: true,
      headers: BASE_HEADERS,
      decompress: true,
      retry: { limit: 0 },
      http2: false,
    });

    return {
      ok: res.statusCode >= 200 && res.statusCode < 400,
      status: res.statusCode,
      finalUrl: res.url,
      body: res.body,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      error: err?.message ?? String(err),
      body: null,
    };
  }
}

// ------------------------------------------------------------------
// Process one hotel URL (with one retry on new session if needed)
// ------------------------------------------------------------------
async function processUrl({
  origUrl,
  getProxySessionUrl,
  timeoutSecs,
  delayMsMin,
  delayMsMax,
}) {
  // First attempt
  const proxyUrl1 = getProxySessionUrl();
  const res1 = await fetchPage({ url: origUrl, proxyUrl: proxyUrl1, timeoutSecs });

  let parsedHtml = null;
  let hotelInfo = null;
  let jsonBlocks = null;

  if (res1.ok && res1.body) {
    jsonBlocks = extractJsonLd(res1.body);
    hotelInfo = pickHotelNode(jsonBlocks);
    parsedHtml = true;
  }

  // Success path
  if (hotelInfo) {
    return {
      url: origUrl,
      finalUrl: res1.finalUrl,
      scrapedAt: new Date().toISOString(),
      jsonLdData: jsonBlocks,
      hotelInfo,
      error: null,
    };
  }

  // Retry (new session) if we had HTTP fail, no body, or no hotelInfo
  const proxyUrl2 = getProxySessionUrl(true); // force new session
  const res2 = await fetchPage({ url: origUrl, proxyUrl: proxyUrl2, timeoutSecs });

  if (res2.ok && res2.body) {
    jsonBlocks = extractJsonLd(res2.body);
    hotelInfo = pickHotelNode(jsonBlocks);
  }

  return {
    url: origUrl,
    finalUrl: res2.finalUrl ?? res1.finalUrl ?? origUrl,
    scrapedAt: new Date().toISOString(),
    jsonLdData: jsonBlocks ?? [],
    hotelInfo: hotelInfo ?? undefined,
    error: hotelInfo ? null : (res2.error || `status:${res2.status}`),
  };
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------
await Actor.init();

const input = await Actor.getInput();
log.info('input', input);

let startUrls = [];
if (Array.isArray(input?.startUrls) && input.startUrls.length > 0) {
  startUrls = input.startUrls.map((r) => ({ url: r.url }));
} else if (input?.url) {
  startUrls = [{ url: input.url }];
}
if (!startUrls.length) {
  log.warning('No startUrls provided; exiting.');
  await Actor.exit();
  process.exit(0);
}

// user knobs
const concurrency = Number(input?.concurrency) || DEFAULT_CONCURRENCY;
const sessionPages = Number(input?.sessionPages) || DEFAULT_SESSION_PAGES;
const timeoutSecs = Number(input?.timeoutSecs) || DEFAULT_TIMEOUT_SECS;
const delayMsMin = Number(input?.delayMsMin) || DEFAULT_DELAY_MS_MIN;
const delayMsMax = Number(input?.delayMsMax) || DEFAULT_DELAY_MS_MAX;

// Proxy config (residential)
const proxyConfiguration = await Actor.createProxyConfiguration({
  groups: ['RESIDENTIAL'],
});

// Session mgmt
let currentSessionId = 1;
let pagesInSession = 0;
function rotateSession() {
  currentSessionId += 1;
  pagesInSession = 0;
}
function getProxySessionUrl(forceNew = false) {
  if (forceNew || pagesInSession >= sessionPages) {
    rotateSession();
  }
  pagesInSession += 1;
  // Apify Proxy sticky session
  return proxyConfiguration.newUrl(`sess_${currentSessionId}`);
}

// Concurrency queue (simple worker pool)
let idx = 0;
let successCount = 0;
let failedCount = 0;
const runStart = Date.now();

async function worker(id) {
  while (idx < startUrls.length) {
    const myIdx = idx++;
    const { url } = startUrls[myIdx];

    log.info(`W${id} -> ${url}`);

    const result = await processUrl({
      origUrl: url,
      getProxySessionUrl,
      timeoutSecs,
      delayMsMin,
      delayMsMax,
    });

    if (result?.hotelInfo) successCount++;
    else failedCount++;

    await Dataset.pushData(result);

    // polite jitter
    const delay = delayMsMin + Math.floor(Math.random() * (delayMsMax - delayMsMin + 1));
    await sleep(delay);
  }
}

// spin workers
const workers = [];
for (let i = 0; i < concurrency; i++) workers.push(worker(i + 1));
await Promise.all(workers);

// Stats
const runDuration = (Date.now() - runStart) / 1000;
const stats = {
  total_urls: startUrls.length,
  successes: successCount,
  failures: failedCount,
  run_duration_seconds: runDuration,
};
log.info('Run stats:', stats);
await Actor.setValue('RUN-STATS', stats);
await Dataset.pushData({ type: 'run-stats', ...stats });

// done
await Actor.exit();
