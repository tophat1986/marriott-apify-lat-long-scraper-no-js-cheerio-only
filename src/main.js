// main.js - Optimized for JSON-LD extraction without Puppeteer
import { Actor, log } from 'apify';
import { CheerioCrawler } from 'crawlee';
import { router } from './routes.js';

await Actor.init();

const input = await Actor.getInput();
log.info('Received input:', input);

let urls = [];
if (Array.isArray(input?.startUrls) && input.startUrls.length > 0) {
    urls = input.startUrls.map(obj => obj.url).filter(Boolean);
} else if (input?.url) {
    urls = [input.url];
}

log.info('Parsed URLs:', urls);

if (urls.length === 0 || urls.some(url => typeof url !== 'string' || !/^https?:\/\//.test(url))) {
    log.error('Invalid or missing URLs in input:', urls);
    throw new Error('Input must have valid URLs.');
}

const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL']
});

let successCount = 0;
let failedCount = 0;
const runStart = Date.now();

const crawler = new CheerioCrawler({
    proxyConfiguration,
    requestHandler: async (context) => {
        try {
            await router(context);
            successCount++;
        } catch (err) {
            context.log.error(`Handler error for ${context.request.url}: ${err.message}`);
            throw err;
        }
    },
    maxRequestsPerCrawl: urls.length,
    maxConcurrency: 10, // Much higher than Puppeteer!
    maxRequestRetries: 2,
    navigationTimeoutSecs: 30,
    failedRequestHandler: async ({ request, log }) => {
        log.error(`FAILED: ${request.url}`);
        failedCount++;
    },
});

await crawler.run(urls.map(url => ({ url })));

const runDuration = (Date.now() - runStart) / 1000;
const stats = {
    total_urls: urls.length,
    successes: successCount,
    failures: failedCount,
    run_duration_seconds: runDuration
};

log.info('Run stats:', stats);
await Actor.setValue('RUN-STATS', stats);
await Actor.pushData({ type: 'run-stats', ...stats });

await Actor.exit();