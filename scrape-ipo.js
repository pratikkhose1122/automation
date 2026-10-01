require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function scrapeIPO() {
    console.log("Starting headless browser with Stealth mode...");
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'] 
    });
    
    try {
        const page = await browser.newPage();
        
        console.log("Navigating to https://www.ipopremium.in/ ...");
        await page.goto('https://www.ipopremium.in/', { waitUntil: 'networkidle2', timeout: 60000 });
        
        console.log("Extracting main table data...");
        const tablesData = await page.evaluate(() => {
            const tables = Array.from(document.querySelectorAll('table'));
            if (tables.length === 0) return [];
            
            const rows = Array.from(tables[0].querySelectorAll('tr'));
            const headers = Array.from(rows[0].querySelectorAll('th, td')).map(h => h.innerText.trim());
            
            const data = [];
            for (let i = 1; i < rows.length; i++) {
                const cells = Array.from(rows[i].querySelectorAll('td'));
                if (cells.length > 0) {
                    const rowData = {};
                    headers.forEach((header, index) => {
                        rowData[header] = cells[index] ? cells[index].innerText.trim() : "";
                        if (header.toUpperCase() === 'ACTION' && cells[index]) {
                            const actionLink = cells[index].querySelector('a, button');
                            if (actionLink && actionLink.href) {
                                rowData['action_url'] = actionLink.href;
                            } else if (actionLink && actionLink.getAttribute('onclick')) {
                                // Sometimes buttons have window.open('url')
                                const onclick = actionLink.getAttribute('onclick');
                                const match = onclick.match(/window\.open\(['"](.*?)['"]/);
                                if (match) rowData['action_url'] = match[1];
                            }
                        }
                    });
                    
                    // Also grab the detailed href link for the second page
                    const link = rows[i].querySelector('a');
                    if (link && link.href) {
                        rowData['detail_url'] = link.href;
                    }
                    data.push(rowData);
                }
            }
            return data;
        });
        
        console.log(`Extracted ${tablesData.length} IPO records from the front page.`);
        
        if (tablesData.length > 0) {
            console.log("Now visiting each IPO's second page for deep details...");
            
            for (const ipo of tablesData) {
                if (ipo['detail_url']) {
                    console.log(`Scraping deep details from: ${ipo['detail_url']}`);
                    try {
                        await page.goto(ipo['detail_url'], { waitUntil: 'networkidle2', timeout: 60000 });
                        
                        // Extract all tables and content from the detail page
                        const detailData = await page.evaluate(() => {
                            const details = {};
                            
                            // 1. Scrape all standard tables (Lot Size, Financials, KPIs)
                            const tables = Array.from(document.querySelectorAll('table'));
                            for (const table of tables) {
                                const rows = Array.from(table.querySelectorAll('tr'));
                                for (const row of rows) {
                                    const cells = Array.from(row.querySelectorAll('td, th')).map(c => c.innerText.trim());
                                    if (cells.length >= 2) {
                                        details[cells[0]] = cells[1];
                                    }
                                }
                            }

                            // 2. Scrape text sections like About, Strengths, Risks
                            // We look for headers matching these keywords and grab their parent card/div text
                            const allElements = Array.from(document.querySelectorAll('h2, h3, h4, h5, .card-title, .card-header'));
                            for (const el of allElements) {
                                const headerText = el.innerText.trim();
                                if (!headerText) continue;
                                
                                const parent = el.closest('.card, .section, .tab-pane, div');
                                if (parent) {
                                    const contentText = parent.innerText.replace(headerText, "").trim();
                                    
                                    if (headerText.includes("About the Company") || headerText === "About") {
                                        details["About the Company"] = contentText;
                                    }
                                    if (headerText.includes("Strengths")) {
                                        details["Strengths"] = contentText;
                                    }
                                    if (headerText.includes("Risk Factors") || headerText.includes("Risks")) {
                                        details["Risk Factors"] = contentText;
                                    }
                                }
                            }

                            // 3. Scrape company logo with robust extraction
                            function getAbsoluteUrl(urlStr) {
                                if (!urlStr) return null;
                                let trimmed = urlStr.trim();
                                if (!trimmed) return null;
                                if (trimmed.startsWith('data:image')) return trimmed;
                                if (trimmed.match(/placeholder/i)) return null;
                                try {
                                    return new URL(trimmed, window.location.origin).href;
                                } catch (e) {
                                    return null;
                                }
                            }

                            let logoUrl = null;
                            const potentialImgs = Array.from(document.querySelectorAll('img'));
                            
                            for (const img of potentialImgs) {
                                const src = img.src || '';
                                const dataSrc = img.getAttribute('data-src') || '';
                                const dataLazySrc = img.getAttribute('data-lazy-src') || '';
                                const dataOriginal = img.getAttribute('data-original') || '';
                                const srcset = img.srcset || img.getAttribute('data-srcset') || '';
                                const alt = (img.alt || '').toLowerCase();
                                
                                let candidate = dataSrc || dataLazySrc || dataOriginal;
                                if (!candidate && srcset) {
                                    candidate = srcset.split(',')[0].trim().split(' ')[0];
                                }
                                if (!candidate) {
                                    candidate = src;
                                }
                                
                                candidate = getAbsoluteUrl(candidate);
                                if (!candidate) continue;

                                const lowerCandidate = candidate.toLowerCase();
                                if (lowerCandidate.includes('ipopremium') && lowerCandidate.includes('logo')) continue;
                                if (lowerCandidate.includes('/img/ads/')) continue;
                                if (lowerCandidate.includes('logo-light') || lowerCandidate.includes('logo-dark')) continue;
                                
                                if (img.closest('.ip-logo') || lowerCandidate.includes('/images/ipo/')) {
                                    logoUrl = candidate;
                                    break;
                                }
                                
                                if (alt.includes('logo') && !logoUrl) {
                                    logoUrl = candidate;
                                }
                            }
                            details["logo_url"] = logoUrl;
                            
                            return details;
                        });
                        
                        // Attach the deep details to the main ipo object
                        ipo['detailed_info'] = detailData;
                        
                    } catch (e) {
                        console.error(`Failed to scrape details for ${ipo['COMPANY']}:`, e.message);
                    }
                }
                
                // Handle Action URL / Allotment Link
                if (ipo['action_url'] && !ipo['action_url'].includes('/bids/create')) {
                    if (!ipo['details']) ipo['details'] = {};
                    if (!ipo['details']['registrarDetails']) ipo['details']['registrarDetails'] = {};
                    ipo['details']['registrarDetails']['allotmentLink'] = ipo['action_url'];
                }

                // Use the company name as a unique ID
                const companyName = ipo['COMPANY'] ? ipo['COMPANY'].split('\\n')[0].trim() : 'Unknown';
                const id = companyName.toLowerCase().replace(/[^a-z0-9]/g, '-');
                
                // Fetch existing row to preserve valid logo
                let existingData = {};
                try {
                    const { data: existingRow } = await supabase.from('ipos').select('data').eq('id', id).maybeSingle();
                    if (existingRow && existingRow.data) {
                        existingData = existingRow.data;
                    }
                } catch (e) {
                    console.error(`Warning: could not fetch existing row for logo preservation: ${e.message}`);
                }

                const existingLogoUrl = (existingData.basic && existingData.basic.logoUrl) || 
                                        (existingData.detailed_info && existingData.detailed_info.logo_url) || null;
                                        
                const newlyExtractedLogo = ipo.detailed_info && ipo.detailed_info.logo_url ? ipo.detailed_info.logo_url : null;
                
                const finalLogoUrl = newlyExtractedLogo || existingLogoUrl;
                
                // Store in data.basic.logoUrl as requested, merging safely if existingData.basic exists
                ipo.basic = { ...(existingData.basic || {}), ...(ipo.basic || {}) };
                ipo.basic.logoUrl = finalLogoUrl;
                
                if (ipo.detailed_info) {
                    ipo.detailed_info.logo_url = finalLogoUrl;
                }
                
                const { error } = await supabase
                    .from('ipos')
                    .upsert({ 
                        id: id, 
                        data: ipo,
                        updated_at: new Date().toISOString()
                    });
                    
                if (error) {
                    console.error(`Error inserting ${companyName}:`, error);
                } else {
                    console.log(`Upserted full data for: ${companyName}`);
                }
            }
            console.log("Successfully updated Supabase with all detailed records!");
        }
        
    } catch (err) {
        console.error("Error scraping IPO site:", err);
    } finally {
        console.log("Closing browser...");
        await browser.close();
    }
}

scrapeIPO();
