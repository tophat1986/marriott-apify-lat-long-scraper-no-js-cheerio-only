// Apify SDK
import { Actor, log } from 'apify';
// Crawlee
import { CheerioCrawler, Dataset, requestAsBrowser } from 'crawlee';

await Actor.init();

const input = await Actor.getInput();
log.info('Received input:', input);

// Build startUrls array
let startUrls = [];
if (Array.isArray(input?.startUrls) && input.startUrls.length > 0) {
  startUrls = input.startUrls;
} else if (input?.url) {
  startUrls = [{ url: input.url }];
}
log.info('URLs to scrape (raw):', startUrls);

// Resolve redirects to reduce crawl failures on short Marriott URLs
async function resolveUrl(u) {
  try {
    const res = await requestAsBrowser({
      url: u,
      timeoutSecs: 8,         // fast fail
      method: 'GET',
      // we do not need body but requestAsBrowser fetches it; timeout keeps limit
      ignoreSslErrors: false,
    });
    // res.url is final loaded url
    if (res?.url && res.url !== u) {
      log.info(`Resolved ${u} -> ${res.url}`);
      return res.url;
    }
  } catch (err) {
    log.warning(`resolveUrl failed for ${u}: ${err?.message ?? err}`);
  }
  return u; // fallback
}

// Produce resolved list (Apify input objects preserved)
const resolvedUrls = [];
for (const rec of startUrls) {
  const orig = rec.url;
  const final = await resolveUrl(orig);
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

  maxRequestRetries: 1,          // fail fast; upstream retry strategy
  navigationTimeoutSecs: 10,     // network budget
  requestHandlerTimeoutSecs: 5,  // parsing budget

  additionalMimeTypes: ['text/html', 'application/xhtml+xml'],

  preNavigationHooks: [
    async ({ request }) => {
      // browser-like headers
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
    // request.url is the resolved (final) URL we’re crawling
    // request.userData.origUrl holds the short URL we started with
    const origUrl = request.userData?.origUrl ?? request.url;
    log.info(`Processing ${request.url} (orig: ${origUrl})`);

    const results = {
      url: origUrl,                       // short input URL
      finalUrl: request.loadedUrl ?? request.url, // actual fetched URL
      scrapedAt: new Date().toISOString(),
      jsonLdData: [],
    };

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

await crawler.run(resolvedUrls);

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

await Actor.exit();
