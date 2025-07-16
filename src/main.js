// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler, Dataset } from 'crawlee';

// Init actor
await Actor.init();

// Get input
const input = await Actor.getInput();
log.info('Received input:', input);

// Parse URLs from input
let startUrls = [];
if (Array.isArray(input?.startUrls) && input.startUrls.length > 0) {
    startUrls = input.startUrls;
} else if (input?.url) {
    startUrls = [{ url: input.url }];
}

log.info('URLs to scrape:', startUrls);

// Proxy (residential pool)
const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL'],
});

let successCount = 0;
let failedCount = 0;
const runStart = Date.now();

const crawler = new CheerioCrawler({
    proxyConfiguration,

    // how many URLs in this batch
    maxRequestsPerCrawl: startUrls.length,

    // parallelism
    maxConcurrency: 10,

    // fail fast to stay under ~10s per URL
    maxRequestRetries: 1,
    requestTimeoutSecs: 10,        // network-level timeout
    requestHandlerTimeoutSecs: 5,  // parsing timeout
    additionalMimeTypes: ['text/html', 'application/xhtml+xml'],

    preNavigationHooks: [
        async ({ request }, gotoOptions) => {
            // Send browser-like headers so Marriott responds quickly
            request.headers = {
                ...request.headers,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                              'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                              'Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
            };
            // Hard cap body size to avoid big downloads
            gotoOptions.maxResponseSizeBytes = 2_000_000;
        },
    ],

    async requestHandler({ request, $, log, response }) {
        log.info(`Processing ${request.url}`);

        const results = {
            // original short URL
            url: request.url,
            // final URL after redirects (CheerioCrawler populates request.loadedUrl)
            finalUrl: request.loadedUrl ?? response?.url() ?? request.url,
            scrapedAt: new Date().toISOString(),
            jsonLdData: [],
        };

        // Extract all JSON-LD scripts
        $('script[type="application/ld+json"]').each((index, element) => {
            try {
                const jsonText = $(element).html();
                if (!jsonText) return;
                const data = JSON.parse(jsonText);
                results.jsonLdData.push(data);

                if (data['@type']) {
                    log.info(`Found JSON-LD type: ${data['@type']}`);
                }
            } catch (e) {
                log.warning(`Failed to parse JSON-LD at index ${index}: ${e.message}`);
            }
        });

        // Pick hotel node if present
        const hotelData = results.jsonLdData.find(
            (item) =>
                item['@type'] === 'Hotel' ||
                item['@type'] === 'LodgingBusiness' ||
                (Array.isArray(item['@type']) && item['@type'].includes('Hotel')),
        );

        if (hotelData) {
            results.hotelInfo = hotelData;
            log.info(`Extracted hotel: ${hotelData.name}`);
        }

        // Save to dataset
        await Dataset.pushData(results);
        successCount++;
    },

    failedRequestHandler({ request, log }) {
        log.error(`Request failed: ${request.url}`);
        failedCount++;
    },
});

// Run the crawler
await crawler.run(startUrls);

// Final stats
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

// Exit
await Actor.exit();
