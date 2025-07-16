# Marriott JSON-LD Scraper

This Actor scrapes JSON-LD structured data from Marriott hotel pages using `CheerioCrawler`. Since the JSON-LD data is included in the initial HTML response, we don't need a full browser - making this scraper much faster and more efficient than Puppeteer-based solutions.

## Why CheerioCrawler instead of PuppeteerCrawler?

- **10-100x faster** - No browser overhead
- **Lower memory usage** - No Chrome instances to manage
- **Higher concurrency** - Can handle many more parallel requests
- **More reliable** - No browser crashes or timeout issues
- **Lower costs** - Uses fewer compute units on Apify platform

## Included features

- **[Cheerio Crawler](https://crawlee.dev/api/cheerio-crawler/class/CheerioCrawler)** - Fast HTML parsing and web scraping
- **[Configurable Proxy](https://crawlee.dev/docs/guides/proxy-management#proxy-configuration)** - Residential proxies for reliability
- **[Dataset](https://docs.apify.com/sdk/js/docs/guides/result-storage#dataset)** - Structured data storage
- **JSON-LD Parser** - Extracts structured data from hotel pages

## Input

The Actor accepts the following input:

```json
{
    "startUrls": [
        { "url": "https://www.marriott.com/ALGMC" },
        { "url": "https://www.marriott.com/BSLMC" }
    ]
}
```

Or a single URL:

```json
{
    "url": "https://www.marriott.com/ALGMC"
}
```

## Output

For each hotel URL, the Actor extracts and stores:

- All JSON-LD structured data found on the page
- Parsed hotel information including:
  - Name, address, phone number
  - Price range and star rating
  - Amenities and features
  - Images and URLs

## How it works

1. Receives input URLs from the Apify platform
2. Uses CheerioCrawler to fetch HTML content through residential proxies
3. Parses JSON-LD data from `<script type="application/ld+json">` tags
4. Extracts and structures the hotel information
5. Saves results to the dataset

## Development

```bash
# Install dependencies
npm install

# Run locally
npm start

# Run with Apify CLI
apify run
```