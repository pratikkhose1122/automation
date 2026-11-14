require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { createClient } = require('@supabase/supabase-js');
const { isFuzzyMatch } = require('./fuzzyMatch');

// Helper parsing functions for canonical schema
function cleanText(v) {
    if (v === null || v === undefined) return '';
    return String(v).trim();
}

function parsePrice(frontPrice, details) {
    let raw = cleanText(frontPrice);
    if (details) {
        for (const [k, v] of Object.entries(details)) {
            if (/price band|issue price/i.test(k) && v && !/tba/i.test(v)) {
                raw = v;
                break;
            }
        }
    }
    raw = raw.replace(/₹|,/g, '').trim();
    if (/tba/i.test(raw) || !raw) {
        return { minPrice: 0, maxPrice: 0 };
    }
    const rangeMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:to|-)\s*(\d+(?:\.\d+)?)/i);
    if (rangeMatch) {
        return {
            minPrice: parseFloat(rangeMatch[1]) || 0,
            maxPrice: parseFloat(rangeMatch[2]) || 0
        };
    }
    const singleMatch = raw.match(/(\d+(?:\.\d+)?)/);
    if (singleMatch) {
        const val = parseFloat(singleMatch[1]) || 0;
        return { minPrice: val, maxPrice: val };
    }
    return { minPrice: 0, maxPrice: 0 };
}

function parseLot(frontLot, details) {
    let raw = cleanText(frontLot);
    if (details) {
        for (const [k, v] of Object.entries(details)) {
            if (/lot size/i.test(k) && v && !/tba/i.test(v)) {
                raw = v;
                break;
            }
        }
    }
    raw = raw.replace(/,/g, '').trim();
    const match = raw.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
}

function parseFaceValue(details) {
    if (!details) return 10;
    for (const [k, v] of Object.entries(details)) {
        if (/face value/i.test(k) && v) {
            const m = String(v).match(/(\d+(?:\.\d+)?)/);
            if (m) return parseFloat(m[1]) || 10;
        }
    }
    return 10;
}

function parseIssueSize(frontIssue, details) {
    let total = 0, fresh = 0, ofs = 0;
    let rawTotal = cleanText(frontIssue);
    if (details) {
        for (const [k, v] of Object.entries(details)) {
            if (/issue size/i.test(k) && !/fresh|ofs/i.test(k) && v && !/tba/i.test(v)) {
                rawTotal = v;
            }
            if (/fresh issue/i.test(k) && v && !/tba/i.test(v)) {
                const fm = String(v).replace(/₹|,/g, '').match(/(\d+(?:\.\d+)?)/);
                if (fm) fresh = parseFloat(fm[1]) || 0;
            }
            if (/offer for sale|ofs/i.test(k) && v && !/tba/i.test(v)) {
                const om = String(v).replace(/₹|,/g, '').match(/(\d+(?:\.\d+)?)/);
                if (om) ofs = parseFloat(om[1]) || 0;
            }
        }
    }
    const tm = rawTotal.replace(/₹|,/g, '').match(/(\d+(?:\.\d+)?)/);
    if (tm) total = parseFloat(tm[1]) || 0;
    return { totalIssueCr: total, freshIssueCr: fresh, ofsCr: ofs };
}

function toISODate(dStr) {
    if (!dStr) return null;
    const trimmed = cleanText(dStr);
    if (/tba/i.test(trimmed) || trimmed === '-' || trimmed === '--' || !trimmed) return null;
    
    const directDate = new Date(trimmed);
    if (!isNaN(directDate.getTime()) && directDate.getFullYear() > 2000) {
        return directDate.toISOString();
    }
    
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const currentYear = new Date().getFullYear();
    
    const m1 = trimmed.match(/(\d{1,2})[\s\-]+([a-zA-Z]{3,9})(?:[\s\-]+(\d{4}))?/);
    if (m1) {
        const day = parseInt(m1[1], 10);
        const mKey = m1[2].substring(0, 3).toLowerCase();
        const year = m1[3] ? parseInt(m1[3], 10) : currentYear;
        if (months[mKey] !== undefined) {
            const dt = new Date(Date.UTC(year, months[mKey], day));
            if (!isNaN(dt.getTime())) return dt.toISOString();
        }
    }
    
    const m2 = trimmed.match(/([a-zA-Z]{3,9})[\s\-]+(\d{1,2})(?:,?\s+(\d{4}))?/);
    if (m2) {
        const mKey = m2[1].substring(0, 3).toLowerCase();
        const day = parseInt(m2[2], 10);
        const year = m2[3] ? parseInt(m2[3], 10) : currentYear;
        if (months[mKey] !== undefined) {
            const dt = new Date(Date.UTC(year, months[mKey], day));
            if (!isNaN(dt.getTime())) return dt.toISOString();
        }
    }
    
    return null;
}

function parseDates(openCloseStr, details) {
    let open = null, close = null, allotment = null, listing = null;
    
    if (details) {
        for (const [k, v] of Object.entries(details)) {
            if (/open date/i.test(k)) open = toISODate(v) || open;
            if (/close date/i.test(k)) close = toISODate(v) || close;
            if (/allotment/i.test(k)) allotment = toISODate(v) || allotment;
            if (/listing date/i.test(k)) listing = toISODate(v) || listing;
        }
    }
    
    if ((!open || !close) && openCloseStr) {
        const parts = openCloseStr.split(/–|-|to/i).map(s => s.trim());
        if (parts.length >= 2) {
            let pOpen = parts[0];
            let pClose = parts[1];
            const monthMatch = pClose.match(/([a-zA-Z]{3,9})/);
            if (!pOpen.match(/[a-zA-Z]{3,9}/) && monthMatch) {
                pOpen += ' ' + monthMatch[1];
            }
            open = open || toISODate(pOpen);
            close = close || toISODate(pClose);
        } else if (parts.length === 1) {
            open = open || toISODate(parts[0]);
        }
    }
    
    return { open, close, allotment, listing };
}

function parseGmp(gmpRaw, maxPrice) {
    if (!gmpRaw) return { value: 0, percent: 0 };
    const str = cleanText(gmpRaw).replace(/₹/g, '');
    if (/tba/i.test(str) || str === '-' || str === '--') {
        return { value: 0, percent: 0 };
    }
    const valMatch = str.match(/([+-]?\d+(?:\.\d+)?)/);
    const pctMatch = str.match(/\(([+-]?\d+(?:\.\d+)?)\s*%\)/);
    
    let val = valMatch ? parseFloat(valMatch[1]) : 0;
    let pct = pctMatch ? parseFloat(pctMatch[1]) : 0;
    
    if (pct === 0 && val > 0 && maxPrice > 0) {
        pct = parseFloat(((val / maxPrice) * 100).toFixed(2));
    }
    return { value: val, percent: pct };
}

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function scrapeIPO() {
    console.log("Checking Auto-Publish Settings...");
    let autoPublish = false;
    try {
        const { data: configRow } = await supabase.from('app_config').select('data').eq('id', 'config').maybeSingle();
        if (configRow && configRow.data && configRow.data.autoPublishScrapedIpos === true) {
            autoPublish = true;
            console.log("Auto-Publish is ENABLED by Admin. New IPOs will be pushed immediately.");
        }
    } catch(e) {}

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
                const rawCompanyName = ipo['COMPANY'] ? ipo['COMPANY'].replace(/\\n|\n/g, ' ').trim() : 'Unknown';
                let cleanName = rawCompanyName.toLowerCase()
                    .replace(/closing today/gi, '')
                    .replace(/closes today/gi, '')
                    .replace(/open today/gi, '')
                    .replace(/new/gi, '')
                    .replace(/ltd\.?/gi, '')
                    .replace(/limited/gi, '')
                    .replace(/mainboard/gi, '')
                    .replace(/sme/gi, '')
                    .replace(/bse/gi, '')
                    .replace(/nse/gi, '')
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/-+/g, '-')
                    .replace(/^-|-$/g, '')
                    .trim();

                let exchangeSuffix = '-mainboard';
                const lowerRaw = rawCompanyName.toLowerCase();
                if (lowerRaw.includes('sme')) {
                    const ex = lowerRaw.includes('nse') ? 'nse' : 'bse';
                    exchangeSuffix = `-${ex}-sme`;
                }

                const id = `${cleanName}${exchangeSuffix}`;
                const companyName = rawCompanyName.split('-')[0].replace(/(Closing|Open) Today/ig, '').trim();
                
                // Fetch existing row — with FUZZY DEDUP fallback
                let existingData = {};
                let resolvedId = id;
                try {
                    // Step 1: Try exact ID match first (fast path)
                    const { data: exactRow } = await supabase.from('ipos').select('id, data').eq('id', id).maybeSingle();
                    if (exactRow && exactRow.data) {
                        existingData = exactRow.data;
                    } else {
                        // Step 2: No exact match — fuzzy scan for renamed duplicates
                        const { data: allRows } = await supabase.from('ipos').select('id, data');
                        if (allRows) {
                            for (const row of allRows) {
                                const existingName = row.data?.basic?.name || row.data?.COMPANY || '';
                                if (existingName && isFuzzyMatch(companyName, existingName)) {
                                    console.log(`  🔗 Fuzzy match: "${companyName}" ≈ "${existingName}" (reusing id: ${row.id})`);
                                    resolvedId = row.id;
                                    existingData = row.data || {};
                                    break;
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error(`Warning: could not fetch existing row for dedup: ${e.message}`);
                }

                const existingLogoUrl = (existingData.basic && existingData.basic.logoUrl) || 
                                        (existingData.detailed_info && existingData.detailed_info.logo_url) || null;
                                        
                const newlyExtractedLogo = ipo.detailed_info && ipo.detailed_info.logo_url ? ipo.detailed_info.logo_url : null;
                const finalLogoUrl = newlyExtractedLogo || existingLogoUrl;

                // Build robust canonical fields merged with existingData
                const isSME = lowerRaw.includes('sme');
                const scrapedPricing = parsePrice(ipo['PRICE'], ipo.detailed_info);
                const scrapedLot = parseLot(ipo['LOT'], ipo.detailed_info);
                const scrapedFaceValue = parseFaceValue(ipo.detailed_info);
                const scrapedIssue = parseIssueSize(ipo['ISSUE SIZE'], ipo.detailed_info);
                const scrapedDates = parseDates(ipo['OPEN – CLOSE'], ipo.detailed_info);

                // Pricing: never downgrade non-zero values to 0
                const pricing = {
                    minPrice: scrapedPricing.minPrice || existingData.pricing?.minPrice || 0,
                    maxPrice: scrapedPricing.maxPrice || existingData.pricing?.maxPrice || 0,
                    lotSize: scrapedLot || existingData.pricing?.lotSize || 0,
                    faceValue: scrapedFaceValue || existingData.pricing?.faceValue || 10,
                };

                // Dates: never wipe out verified dates
                const dates = {
                    open: scrapedDates.open || existingData.dates?.open || null,
                    close: scrapedDates.close || existingData.dates?.close || null,
                    allotment: scrapedDates.allotment || existingData.dates?.allotment || null,
                    listing: scrapedDates.listing || existingData.dates?.listing || null,
                };

                // Issue: never wipe out verified issue sizes
                const issue = {
                    totalIssueCr: scrapedIssue.totalIssueCr || existingData.issue?.totalIssueCr || 0,
                    freshIssueCr: scrapedIssue.freshIssueCr || existingData.issue?.freshIssueCr || 0,
                    ofsCr: scrapedIssue.ofsCr || existingData.issue?.ofsCr || 0,
                    issueType: existingData.issue?.issueType || (isSME ? 'SME' : 'Book Built'),
                };

                // GMP & Continuous History: append new timestamped snapshots, never drop history
                const scrapedGmp = parseGmp(ipo['GMP RUMORS *'] || ipo['GMP'], pricing.maxPrice);
                const existingHistory = Array.isArray(existingData.gmp?.history) 
                    ? existingData.gmp.history 
                    : (Array.isArray(existingData.gmp_history) ? existingData.gmp_history : []);
                let newHistory = [...existingHistory];

                const nowIso = new Date().toISOString();
                let currentGmpValue = existingData.gmp?.value || 0;
                let currentGmpPercent = existingData.gmp?.percent || 0;
                let lastGmpUpdated = existingData.gmp?.updated || nowIso;

                if (scrapedGmp.value > 0) {
                    currentGmpValue = scrapedGmp.value;
                    currentGmpPercent = scrapedGmp.percent;
                    lastGmpUpdated = nowIso;
                    
                    const latestEntry = newHistory.length > 0 ? newHistory[newHistory.length - 1] : null;
                    const isDifferent = !latestEntry || latestEntry.gmp !== currentGmpValue;
                    if (isDifferent) {
                        newHistory.push({
                            gmp: currentGmpValue,
                            price: pricing.maxPrice || 0,
                            gainPercent: currentGmpPercent,
                            estListingPrice: (pricing.maxPrice || 0) + currentGmpValue,
                            date: nowIso
                        });
                    }
                } else if (currentGmpValue > 0 && newHistory.length === 0) {
                    newHistory.push({
                        gmp: currentGmpValue,
                        price: pricing.maxPrice || 0,
                        gainPercent: currentGmpPercent,
                        estListingPrice: (pricing.maxPrice || 0) + currentGmpValue,
                        date: lastGmpUpdated
                    });
                }

                const gmp = {
                    value: currentGmpValue,
                    percent: currentGmpPercent,
                    updated: lastGmpUpdated,
                    history: newHistory,
                };

                // Basic
                const basic = {
                    ...(existingData.basic || {}),
                    name: existingData.basic?.name || companyName,
                    category: existingData.basic?.category || (isSME ? 'SME' : 'Mainboard'),
                    logoUrl: finalLogoUrl,
                    registrar: existingData.basic?.registrar || ipo.detailed_info?.['Registrar'] || null,
                };

                // Reservation: NEVER discard existing breakdown or quotas!
                const reservation = existingData.reservation || {
                    retail: 35,
                    hni: 15,
                    qib: 50,
                    breakdown: []
                };

                // Details & Lot Distribution: NEVER discard existing details!
                const details = {
                    ...(existingData.details || {}),
                    ...(ipo.details || {}),
                };
                if (ipo.detailed_info) {
                    if (ipo.detailed_info['About the Company']) details.about = ipo.detailed_info['About the Company'];
                    if (ipo.detailed_info['Strengths']) details.strengths = ipo.detailed_info['Strengths'];
                    if (ipo.detailed_info['Risk Factors']) details.risks = ipo.detailed_info['Risk Factors'];
                }

                // Final status & meta
                const shouldPublish = autoPublish || (existingData.meta?.published || false);
                let finalStatus = existingData.meta?.status;
                if (shouldPublish && (!finalStatus || finalStatus.toUpperCase() === 'DRAFT')) {
                    finalStatus = 'UPCOMING';
                } else if (!finalStatus) {
                    finalStatus = 'DRAFT';
                }

                const meta = {
                    ...(existingData.meta || {}),
                    status: finalStatus,
                    published: shouldPublish,
                    lastUpdated: nowIso
                };

                // Complete canonical object merged with existingData and newly scraped fields
                const finalData = {
                    ...existingData,     // 1. Preserves existing fields (listing, subscription, etc.)
                    ...ipo,              // 2. Contains scraped fields
                    id: resolvedId,
                    basic,
                    pricing,
                    issue,
                    dates,
                    gmp,
                    gmp_history: newHistory,
                    reservation,
                    details,
                    meta,
                    updated_at: nowIso
                };

                const { error } = await supabase
                    .from('ipos')
                    .upsert({ 
                        id: resolvedId, 
                        data: finalData,
                        updated_at: nowIso
                    });
                    
                if (error) {
                    console.error(`Error inserting ${companyName}:`, error);
                } else {
                    console.log(`Upserted full structured data for: ${companyName} (Price: ${pricing.minPrice}-${pricing.maxPrice}, Lot: ${pricing.lotSize}, GMP: ${gmp.value})`);
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
