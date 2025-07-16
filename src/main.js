// Apify SDK - toolkit for building Apify Actors (Read more at https://docs.apify.com/sdk/js/)
import { Actor, log } from 'apify';
// Crawlee - web scraping and browser automation library (Read more at https://crawlee.dev)
import { CheerioCrawler, Dataset } from 'crawlee';

// The init() call configures the Actor for its environment. It's recommended to start every Actor with an init()
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

// Create proxy configuration
const proxyConfiguration = await Actor.createProxyConfiguration({
    groups: ['RESIDENTIAL']
});

let successCount = 0;
let failedCount = 0;
const runStart = Date.now();

const crawler = new CheerioCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: startUrls.length,
    maxConcurrency: 10,
    maxRequestRetries: 2,
    navigationTimeoutSecs: 30,
    
    async requestHandler({ request, $, log }) {
        log.info(`Processing ${request.url}`);
        
        const results = {
            url: request.url,
            scrapedAt: new Date().toISOString(),
            jsonLdData: []
        };
        
        // Extract all JSON-LD scripts
        $('script[type="application/ld+json"]').each((index, element) => {
            try {
                const jsonText = $(element).html();
                const data = JSON.parse(jsonText);
                results.jsonLdData.push(data);
                
                // Log what we found
                if (data['@type']) {
                    log.info(`Found JSON-LD type: ${data['@type']}`);
                }
            } catch (e) {
                log.warning(`Failed to parse JSON-LD at index ${index}: ${e.message}`);
            }
        });
        
        // Extract specific hotel data if available
        const hotelData = results.jsonLdData.find(
            item => item['@type'] === 'Hotel' || 
                    item['@type'] === 'LodgingBusiness' ||
                    (Array.isArray(item['@type']) && item['@type'].includes('Hotel'))
        );
        
        if (hotelData) {
            // Store the complete hotel data - don't miss any fields!
            results.hotelInfo = hotelData;
            log.info(`Extracted hotel: ${hotelData.name}`);
        }
        
        // Save to Dataset
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

// Log final stats
const runDuration = (Date.now() - runStart) / 1000;
const stats = {
    total_urls: startUrls.length,
    successes: successCount,
    failures: failedCount,
    run_duration_seconds: runDuration
};

log.info('Run stats:', stats);
await Actor.setValue('RUN-STATS', stats);
await Dataset.pushData({ type: 'run-stats', ...stats });

// Gracefully exit the Actor process. It's recommended to quit all Actors with an exit()
await Actor.exit();