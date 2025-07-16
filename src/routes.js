// routes.js - Extract JSON-LD data
import { createCheerioRouter, Dataset } from 'crawlee';

export const router = createCheerioRouter();

router.addDefaultHandler(async ({ request, $, log }) => {
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
        results.hotelInfo = {
            name: hotelData.name,
            address: hotelData.address,
            telephone: hotelData.telephone,
            url: hotelData.url,
            image: hotelData.image,
            priceRange: hotelData.priceRange,
            starRating: hotelData.starRating,
            amenities: hotelData.amenityFeature
        };
        log.info(`Extracted hotel: ${hotelData.name}`);
    }
    
    // Store the data
    await Dataset.pushData(results);
});