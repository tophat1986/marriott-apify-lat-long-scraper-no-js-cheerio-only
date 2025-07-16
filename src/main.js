import { Actor, log } from 'apify';
import { CheerioCrawler, Dataset } from 'crawlee';

await Actor.init();

const input = await Actor.getInput();
log.info('Received input:', input);

let startUrls = [];
if (Array.isArray(input?.startUrls) && input.startUrls.length > 0) {
  startUrls = input.startUrls;
} else if (input?.url) {
  startUrls = [{ url: input.url }];
}
log.info('URLs to scrape:', startUrls);

// Proxy
const proxyConfiguration = await Actor.createProxyConfiguration({
  groups: ['RESIDENTIAL'],
});

let successCount = 0;
let failedCount = 0;
const runStart = Date.now();

const crawler = new CheerioCrawler({
  proxyConfiguration,

  maxRequestsPerCrawl: startUrls.length,
  maxConcurrency: 10,

  maxRequestRetries: 1,              // fail fast
  navigationTimeoutSecs: 10,         // network timeout
  requestHandlerTimeoutSecs: 5,      // parsing timeout
  maxResponseBodySizeBytes: 2_000_000, // ~2 MB cap

  additionalMimeTypes: ['text/html', 'application/xhtml+xml'],

  preNavigationHooks: [
    async ({ request }) => {
      request.headers = {
        ...request.headers,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                      'Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.8',
        'Connection': 'keep-alive',
      };
    },
  ],

  async requestHandler({ request, $, log }) {
    log.info(`Processing ${request.url}`);

    const results = {
      url: request.url,
      finalUrl: request.loadedUrl ?? request.url,
      scrapedAt: new Date().toISOString(),
      jsonLdData: [],
    };

    // Collect all JSON-LD blocks
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

    // Pick hotel block
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

await crawler.run(startUrls);

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
