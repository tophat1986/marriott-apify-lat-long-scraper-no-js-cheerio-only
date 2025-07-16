// Apify SDK
import { Actor, log } from 'apify';
// Crawlee
import { CheerioCrawler, Dataset } from 'crawlee';

await Actor.init();

const input = await Actor.getInput();
log.info('Received input:', input);

// Build startUrls
let startUrls = [];
if (Array.isArray(input?.startUrls) && input.startUrls.length > 0) {
  startUrls = input.startUrls;
} else if (input?.url) {
  startUrls = [{ url: input.url }];
}
log.info('URLs to scrape (raw):', startUrls);

// --- redirect resolver using native fetch ---
async function resolveUrl(u) {
  const controller = new AbortController();
  const timeoutMs = 8000; // 8s budget
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // HEAD -> follow redirects
    const headRes = await fetch(u, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    clearTimeout(t);
    if (headRes?.url) {
      if (headRes.url !== u) log.info(`Resolved (HEAD) ${u} -> ${headRes.url}`);
      return headRes.url;
    }
  } catch (err) {
    clearTimeout(t);
    log.warning(`HEAD resolve failed for ${u}: ${err?.message ?? err}`);
  }

  // fallback GET but still short timeout
  const controller2 = new AbortController();
  const t2 = setTimeout(() => controller2.abort(), timeoutMs);
  try {
    const getRes = await fetch(u, { method: 'GET', redirect: 'follow', signal: controller2.signal });
    clearTimeout(t2);
    if (getRes?.url) {
      if (getRes.url !== u) log.info(`Resolved (GET) ${u} -> ${getRes.url}`);
      return getRes.url;
    }
  } catch (err2) {
    clearTimeout(t2);
    log.warning(`GET resolve failed for ${u}: ${err2?.message ?? err2}`);
  }

  return u; // fallback to original
}

// produce resolved list
const resolvedUrls = [];
for (const rec of startUrls) {
  const orig = rec.url;
  const final = await resolveUrl(orig);
  // keep origUrl in userData so we can output both
  resolvedUrls.push({ url: final, userData: { origUrl: orig } });
}
log.info('URLs to scrape (resolved):', resolvedUrls);

// Proxy (residential)
const proxyConfiguration = await Actor.createProxyConfiguration({
  groups: ['RESIDENTIAL'],
});

let successCount = 0;
let failedCount = 0;
const runStart = Date.now();

const crawler = new CheerioCrawler({
  proxyConfiguration,

  maxRequestsPerCrawl: resolvedUrls.length,
  maxConcurrency: 10,

  // tight performance knobs
  maxRequestRetries: 1,
  navigationTimeoutSecs: 30,
  requestHandlerTimeoutSecs: 5,

  additionalMimeTypes: ['text/html', 'application/xhtml+xml'],

  preNavigationHooks: [
    async ({ request }) => {
      request.headers = {
        ...request.headers,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
          'AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/124.0.0.0 Safari/537.36',
        'Accept':
          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.8',
        'Connection': 'keep-alive',
      };
    },
  ],

  async requestHandler({ request, $, log }) {
    const origUrl = request.userData?.origUrl ?? request.url;
    log.info(`Processing ${request.url} (orig: ${origUrl})`);

    const results = {
      url: origUrl,                                  // short input URL
      finalUrl: request.loadedUrl ?? request.url,    // resolved / crawled URL
      scrapedAt: new Date().toISOString(),
      jsonLdData: [],
    };

    // collect ld+json
    $('script[type="application/ld+json"]').each((index, el) => {
      try {
        const txt = $(el).html();
        if (!txt) return;
        const data = JSON.parse(txt);
        results.jsonLdData.push(data);
        if (data['@type']) log.info(`Found JSON-LD type: ${data['@type']}`);
      } catch (e) {
        log.warning(`JSON-LD parse fail idx ${index}: ${e.message}`);
      }
    });

    // pick hotel
    const hotelData = results.jsonLdData.find(
      (item) =>
        item?.['@type'] === 'Hotel' ||
        item?.['@type'] === 'LodgingBusiness' ||
        (Array.isArray(item?.['@type']) && item['@type'].includes('Hotel')),
    );
    if (hotelData) {
      results.hotelInfo = hotelData;
      log.info(`Extracted hotel: ${hotelData.name}`);
    }

    await Dataset.pushData(results);
    successCount++;
  },

  failedRequestHandler({ request, log }) {
    log.error(`Request failed: ${request.url}`);
    failedCount++;
  },
});

// run
await crawler.run(resolvedUrls);

// stats
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

await Actor.exit();
