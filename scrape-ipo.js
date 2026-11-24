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
    const rangeMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:to|[–—\-])\s*(\d+(?:\.\d+)?)/i);
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
                const crMatch = String(v).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(?:cr|crore)/i);
                if (crMatch) {
                    fresh = parseFloat(crMatch[1]) || 0;
                } else {
                    const fm = String(v).replace(/₹|,/g, '').match(/(\d+(?:\.\d+)?)/);
                    if (fm) {
                        const val = parseFloat(fm[1]) || 0;
                        if (val < 50000) fresh = val;
                    }
                }
            }
            if (/offer for sale|ofs/i.test(k) && v && !/tba/i.test(v)) {
                const crMatch = String(v).replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(?:cr|crore)/i);
                if (crMatch) {
                    ofs = parseFloat(crMatch[1]) || 0;
                } else {
                    const om = String(v).replace(/₹|,/g, '').match(/(\d+(?:\.\d+)?)/);
                    if (om) {
                        const val = parseFloat(om[1]) || 0;
                        if (val < 50000) ofs = val;
                    }
                }
            }
        }
    }
    
    // Total Issue parsing:
    // 1. Prefer explicit Crore value (e.g., "₹8,981.12 Cr", "up to ₹455.72 Cr", "455.72 cr")
    const crMatch = rawTotal.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(?:cr|crore)/i);
    if (crMatch) {
        total = parseFloat(crMatch[1]) || 0;
    } else {
        // 2. Check for Rupee prefix before a number (e.g., "₹455.72")
        const rupeeMatch = rawTotal.replace(/,/g, '').match(/₹\s*(\d+(?:\.\d+)?)/);
        if (rupeeMatch) {
            const val = parseFloat(rupeeMatch[1]) || 0;
            if (val < 50000) total = val;
        } else {
            // 3. General match, but guard against share count! (>50,000 is shares, not Crores)
            const tm = rawTotal.replace(/₹|,/g, '').match(/(\d+(?:\.\d+)?)/);
            if (tm) {
                const val = parseFloat(tm[1]) || 0;
                if (val < 50000) total = val;
            }
        }
    }
    return { totalIssueCr: total, freshIssueCr: fresh, ofsCr: ofs };
}

function toISODate(dStr) {
    if (!dStr) return null;
    let trimmed = cleanText(dStr);
    if (/tba/i.test(trimmed) || trimmed === '-' || trimmed === '--' || !trimmed) return null;
    // Strip trailing status phrases like "Opens in 3 days", "Closes today", etc.
    trimmed = trimmed.replace(/\b(opens|closes|closing|allotment|listing)\b.*$/i, '').trim();
    
    const currentYear = new Date().getFullYear();
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

    // Only allow direct new Date() if an explicit 4-digit year >= 2024 is in the string!
    // Without explicit year, new Date('Nov 19') defaults to year 2001 in V8/Node!
    const yearMatch = trimmed.match(/\b(202\d)\b/);
    if (yearMatch) {
        const directDate = new Date(trimmed);
        if (!isNaN(directDate.getTime()) && directDate.getFullYear() >= 2024) {
            return directDate.toISOString();
        }
    }
    
    const m1 = trimmed.match(/(\d{1,2})[\s\-\/]+([a-zA-Z]{3,9})(?:[\s\-\/]+(\d{4}))?/);
    if (m1) {
        const day = parseInt(m1[1], 10);
        const mKey = m1[2].substring(0, 3).toLowerCase();
        const year = m1[3] ? parseInt(m1[3], 10) : currentYear;
        if (months[mKey] !== undefined && day >= 1 && day <= 31) {
            const dt = new Date(Date.UTC(year, months[mKey], day));
            if (!isNaN(dt.getTime())) return dt.toISOString();
        }
    }
    
    const m2 = trimmed.match(/([a-zA-Z]{3,9})[\s\-\/]+(\d{1,2})(?:,?[\s\-\/]+(\d{4}))?/);
    if (m2) {
        const mKey = m2[1].substring(0, 3).toLowerCase();
        const day = parseInt(m2[2], 10);
        const year = m2[3] ? parseInt(m2[3], 10) : currentYear;
        if (months[mKey] !== undefined && day >= 1 && day <= 31) {
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
        const parts = openCloseStr.split(/[–—\-]|\bto\b/i).map(s => s.trim());
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

    console.log("Fetching existing Supabase records for deduplication and subscription preservation...");
    let allSupabaseRows = [];
    try {
        const { data: rows, error: rowsErr } = await supabase.from('ipos').select('id, data');
        if (!rowsErr && rows) {
            allSupabaseRows = rows;
            console.log(`Fetched ${allSupabaseRows.length} existing records from Supabase.`);
        }
    } catch(e) {
        console.warn("Could not pre-fetch Supabase rows:", e.message);
    }

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
                            let lotDistribution = null;
                            let reservationBreakdown = null;
                            let subscriptionData = null;
                            
                            // 1. Scrape all standard tables (Lot Size, Financials, KPIs, Reservation)
                            const tables = Array.from(document.querySelectorAll('table'));
                            for (const table of tables) {
                                const trs = Array.from(table.querySelectorAll('tr'));
                                if (trs.length === 0) continue;
                                const headerCells = Array.from(trs[0].querySelectorAll('th, td')).map(c => c.innerText.trim().toUpperCase());

                                // Check for Lot Distribution Table: CATEGORY, LOTS, SHARES, AMOUNT, RESERVED
                                if (headerCells.includes('CATEGORY') && headerCells.includes('SHARES') && (headerCells.includes('AMOUNT') || headerCells.includes('RESERVED'))) {
                                    const dist = {};
                                    for (let r = 1; r < trs.length; r++) {
                                        const cells = Array.from(trs[r].querySelectorAll('td')).map(c => c.innerText.trim());
                                        if (cells.length < 5) continue;
                                        const cat = cells[0].toLowerCase();
                                        const shares = parseInt(cells[2].replace(/[^\d]/g, ''), 10) || 0;
                                        const amt = parseInt(cells[3].replace(/[^\d]/g, ''), 10) || 0;
                                        const apps = parseInt(cells[4].replace(/[^\d]/g, ''), 10) || 0;

                                        if (cat.includes('retail')) {
                                            dist.retailMinShare = shares;
                                            dist.retailMinAmt = amt;
                                            dist.retailApplications = apps;
                                        } else if (cat.includes('shni') || cat.includes('s-hni') || cat.includes('small hni')) {
                                            dist.sHniMinShare = shares;
                                            dist.sHniMinAmt = amt;
                                            dist.sHniApplications = apps;
                                        } else if (cat.includes('bhni') || cat.includes('b-hni') || cat.includes('big hni')) {
                                            dist.bHniMinShare = shares;
                                            dist.bHniMinAmt = amt;
                                            dist.bHniApplications = apps;
                                        }
                                    }
                                    if (Object.keys(dist).length > 0) {
                                        lotDistribution = dist;
                                    }
                                }

                                // Check for Reservation Breakdown Table: CATEGORY, SHARES OFFERED, SHARE / %
                                if (headerCells.includes('CATEGORY') && (headerCells.includes('SHARES OFFERED') || headerCells.some(h => h.includes('SHARES'))) && (headerCells.includes('SHARE') || headerCells.some(h => h.includes('%')))) {
                                    const rows = [];
                                    for (let r = 1; r < trs.length; r++) {
                                        const cells = Array.from(trs[r].querySelectorAll('td')).map(c => c.innerText.trim());
                                        if (cells.length < 3) continue;
                                        const cat = cells[0].trim();
                                        const shares = parseInt(cells[1].replace(/[^\d]/g, ''), 10) || 0;
                                        const pctStr = cells[2].replace(/[^\d.]/g, '');
                                        const pct = parseFloat(pctStr) || 0;
                                        if (cat) {
                                            rows.push({ category: cat, shares: shares, percent: pct });
                                        }
                                    }
                                    if (rows.length > 0) {
                                        reservationBreakdown = rows;
                                    }
                                }

                                // Check for Listing Debut Table: EXCHANGE, LISTED AT, GAIN, %
                                if (headerCells.includes('EXCHANGE') && (headerCells.includes('LISTED AT') || headerCells.some(h => h.includes('LISTED')))) {
                                    const listingData = {};
                                    for (let r = 1; r < trs.length; r++) {
                                        const cells = Array.from(trs[r].querySelectorAll('td')).map(c => c.innerText.trim());
                                        if (cells.length < 2) continue;
                                        const ex = cells[0].toUpperCase();
                                        const listedAt = parseFloat(cells[1].replace(/[^\d.]/g, '')) || 0;
                                        let gainPct = 0;
                                        if (cells.length >= 4) {
                                            gainPct = parseFloat(cells[3].replace(/[^\d.-]/g, '')) || 0;
                                        } else if (cells.length >= 3) {
                                            gainPct = parseFloat(cells[2].replace(/[^\d.-]/g, '')) || 0;
                                        }

                                        if (ex.includes('BSE')) {
                                            listingData.listingPriceBse = listedAt;
                                            listingData.listingGainBse = gainPct;
                                        }
                                        if (ex.includes('NSE')) {
                                            listingData.listingPriceNse = listedAt;
                                            listingData.listingGainNse = gainPct;
                                        }
                                        listingData.listedPrice = listedAt || listingData.listedPrice;
                                        listingData.listingGainPercent = gainPct || listingData.listingGainPercent;
                                        listingData.currentPriceExchange = ex.includes('BSE') ? 'BSE' : 'NSE';
                                    }
                                    if (listingData.listedPrice > 0) {
                                        details['listingData'] = listingData;
                                    }
                                }

                                // Check for Day-Wise Subscription Table: CATEGORY, DAY 1, DAY 2, ...
                                if (headerCells.includes('CATEGORY') && headerCells.some(h => /DAY\s*1/i.test(h))) {
                                    const dayCols = headerCells.slice(1);
                                    const rows = [];
                                    for (let r = 1; r < trs.length; r++) {
                                        const cells = Array.from(trs[r].querySelectorAll('td')).map(c => c.innerText.trim());
                                        if (cells.length < 2) continue;
                                        const cat = cells[0];
                                        const values = {};
                                        dayCols.forEach((colName, cIdx) => {
                                            const val = parseFloat(String(cells[cIdx + 1] || '').replace(/₹|,/g, '')) || 0;
                                            values[colName] = val;
                                        });
                                        rows.push({ category: cat, ...values });
                                    }
                                    if (rows.length > 0) {
                                        if (!subscriptionData) subscriptionData = {};
                                        subscriptionData.dayWise = rows;
                                    }
                                }

                                // Check for By Applications Table: CATEGORY, RESERVED, APPLIED, TIMES
                                if (headerCells.includes('CATEGORY') && headerCells.includes('RESERVED') && (headerCells.includes('APPLIED') || headerCells.includes('APPLICATIONS'))) {
                                    const appData = {};
                                    for (let r = 1; r < trs.length; r++) {
                                        const cells = Array.from(trs[r].querySelectorAll('td')).map(c => c.innerText.trim());
                                        if (cells.length < 4) continue;
                                        const catLower = cells[0].toLowerCase();
                                        const reserved = parseInt(cells[1].replace(/[^\d]/g, ''), 10) || 0;
                                        const applied = parseInt(cells[2].replace(/[^\d]/g, ''), 10) || 0;
                                        const times = parseFloat(cells[3].replace(/[^\d.]/g, '')) || 0;

                                        if (catLower.includes('10l+') || catLower.includes('bhni') || catLower.includes('big hni')) {
                                            appData.bigHni = { reserved, applied, times };
                                        } else if (catLower.includes('2-10l') || catLower.includes('3-10l') || catLower.includes('shni') || catLower.includes('small hni')) {
                                            appData.smallHni = { reserved, applied, times };
                                        } else if (catLower.includes('individual') || catLower.includes('retail')) {
                                            appData.retail = { reserved, applied, times };
                                        } else if (catLower.includes('employee')) {
                                            appData.employee = { reserved, applied, times };
                                        } else if (catLower.includes('shareholder')) {
                                            appData.shareholder = { reserved, applied, times };
                                        }
                                    }
                                    if (Object.keys(appData).length > 0) {
                                        if (!subscriptionData) subscriptionData = {};
                                        subscriptionData.byApplications = appData;
                                    }
                                }

                                // Check for By Amount / Demand Table (₹ Crores) vs By Shares Table
                                if (headerCells.includes('CATEGORY') && (headerCells.includes('OFFERED') || headerCells.some(h => h.includes('OFFERED'))) && (headerCells.includes('APPLIED') || headerCells.includes('DEMAND')) && headerCells.includes('TIMES')) {
                                    const rows = [];
                                    let hasFiiOrDii = false;
                                    let isDecimalDemand = false;

                                    for (let r = 1; r < trs.length; r++) {
                                        const cells = Array.from(trs[r].querySelectorAll('td')).map(c => c.innerText.trim());
                                        if (cells.length < 4) continue;
                                        const cat = cells[0];
                                        const offered = parseFloat(cells[1].replace(/₹|,/g, '')) || 0;
                                        const appliedOrDemand = parseFloat(cells[2].replace(/₹|,/g, '')) || 0;
                                        const times = parseFloat(cells[3].replace(/[^\d.]/g, '')) || 0;

                                        if (/fii|dii|mutual|bank|dfi/i.test(cat)) hasFiiOrDii = true;
                                        if (cells[2].includes('.') && appliedOrDemand < 50000) isDecimalDemand = true;

                                        rows.push({ category: cat, offered, appliedOrDemand, times });
                                    }

                                    if (hasFiiOrDii || isDecimalDemand || headerCells.includes('DEMAND')) {
                                        if (!subscriptionData) subscriptionData = {};
                                        subscriptionData.byAmount = { rows };
                                    } else {
                                        if (!subscriptionData) subscriptionData = {};
                                        subscriptionData.byShares = { rows };
                                    }
                                }

                                // Key-value extraction for general details
                                for (const row of trs) {
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
                            details["lotDistribution"] = lotDistribution;
                            details["reservationBreakdown"] = reservationBreakdown;
                            details["subscriptionData"] = subscriptionData;
                            
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
                
                // Fetch existing row — with FUZZY DEDUP fallback using pre-fetched cache
                let existingData = {};
                let resolvedId = id;
                try {
                    // Step 1: Try exact ID match first
                    const exactRow = allSupabaseRows.find(r => r.id === id);
                    if (exactRow && exactRow.data) {
                        existingData = exactRow.data;
                    } else {
                        // Step 2: Fuzzy scan for renamed duplicates
                        for (const row of allSupabaseRows) {
                            const existingName = row.data?.basic?.name || row.data?.COMPANY || '';
                            if (existingName && isFuzzyMatch(companyName, existingName)) {
                                // HISTORICAL ENTITY PROTECTION:
                                // If the existing row is already CLOSED or LISTED or has past dates,
                                // and the newly scraped IPO is UPCOMING, DO NOT reuse its ID!
                                const existingStatus = (row.data?.meta?.status || '').toUpperCase();
                                const hasListedPrice = row.data?.listing?.listedPrice > 0;
                                const existingClose = row.data?.dates?.close;
                                const isPastClose = existingClose && new Date(existingClose) < new Date();
                                const isHistorical = existingStatus === 'CLOSED' || existingStatus === 'LISTED' || hasListedPrice || isPastClose;
                                
                                const isNewUpcoming = scrapedDates.open && new Date() < new Date(scrapedDates.open);
                                if (isHistorical && isNewUpcoming) {
                                    console.log(`  🛡️ Historical protection: "${companyName}" will NOT overwrite historical row ${row.id} ("${existingName}")`);
                                    continue;
                                }

                                console.log(`  🔗 Fuzzy match: "${companyName}" ≈ "${existingName}" (reusing id: ${row.id})`);
                                resolvedId = row.id;
                                existingData = row.data || {};
                                break;
                            }
                        }
                    }
                } catch (e) {
                    console.error(`Warning: could not resolve existing row for dedup: ${e.message}`);
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

                // Dates: never wipe out verified dates, and ensure valid year (>= 2024)
                let finalOpen = scrapedDates.open || existingData.dates?.open || null;
                let finalClose = scrapedDates.close || existingData.dates?.close || null;
                if (finalOpen && new Date(finalOpen).getFullYear() < 2024) {
                    finalOpen = new Date(new Date(finalOpen).setFullYear(new Date().getFullYear())).toISOString();
                }
                if (finalClose && new Date(finalClose).getFullYear() < 2024) {
                    finalClose = new Date(new Date(finalClose).setFullYear(new Date().getFullYear())).toISOString();
                }
                const dates = {
                    open: finalOpen,
                    close: finalClose,
                    allotment: scrapedDates.allotment || existingData.dates?.allotment || null,
                    listing: scrapedDates.listing || existingData.dates?.listing || null,
                };

                // Issue: never wipe out verified issue sizes, and guard against raw share counts (>= 50,000)
                let resolvedTotal = scrapedIssue.totalIssueCr || 0;
                if (!resolvedTotal && existingData.issue?.totalIssueCr && existingData.issue.totalIssueCr < 50000) {
                    resolvedTotal = existingData.issue.totalIssueCr;
                }
                const issue = {
                    totalIssueCr: resolvedTotal,
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

                // Basic & Stock Exchange Symbols
                let nseSymbol = existingData.basic?.nseSymbol || '';
                let bseCode = existingData.basic?.bseCode || '';
                if (ipo.detailed_info) {
                    for (const [k, v] of Object.entries(ipo.detailed_info)) {
                        if (/nse symbol/i.test(k) && v && !nseSymbol) nseSymbol = String(v).trim();
                        if (/bse (scrip )?code/i.test(k) && v && !bseCode) bseCode = String(v).trim();
                        if (/^symbol$/i.test(k) && v && !nseSymbol) nseSymbol = String(v).trim();
                    }
                }

                const basic = {
                    ...(existingData.basic || {}),
                    name: existingData.basic?.name || companyName,
                    symbol: existingData.basic?.symbol || nseSymbol || bseCode || (companyName.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase()),
                    nseSymbol: nseSymbol || existingData.basic?.nseSymbol || '',
                    bseCode: bseCode || existingData.basic?.bseCode || '',
                    category: existingData.basic?.category || (isSME ? 'SME' : 'Mainboard'),
                    logoUrl: finalLogoUrl,
                    registrar: existingData.basic?.registrar || ipo.detailed_info?.['Registrar'] || null,
                };

                // Reservation: populate from newly scraped breakdown if available, else preserve existing
                let reservation = existingData.reservation || {
                    retail: 35,
                    hni: 15,
                    qib: 50,
                    breakdown: []
                };

                const scrapedBreakdown = ipo.detailed_info?.reservationBreakdown;
                if (Array.isArray(scrapedBreakdown) && scrapedBreakdown.length > 0) {
                    const findCat = (keywords) => scrapedBreakdown.find(r => keywords.some(k => r.category.toLowerCase().includes(k.toLowerCase())));

                    const qibRow = findCat(['qib']);
                    const hniRow = findCat(['hni', 'nii']);
                    const retailRow = findCat(['retail']);
                    const shRow = findCat(['shareholder', 'share holder']);
                    const empRow = findCat(['employee']);
                    const anchorRow = findCat(['anchor']);
                    const totalRow = findCat(['total']);

                    reservation = {
                        ...(existingData.reservation || {}),
                        qib: qibRow ? qibRow.percent : (existingData.reservation?.qib || 50),
                        hni: hniRow ? hniRow.percent : (existingData.reservation?.hni || 15),
                        retail: retailRow ? retailRow.percent : (existingData.reservation?.retail || 35),
                        shareholder: shRow ? shRow.percent : (existingData.reservation?.shareholder || null),
                        employee: empRow ? empRow.percent : (existingData.reservation?.employee || null),
                        anchor: anchorRow ? anchorRow.percent : (existingData.reservation?.anchor || null),
                        qibShares: qibRow ? qibRow.shares : (existingData.reservation?.qibShares || 0),
                        hniShares: hniRow ? hniRow.shares : (existingData.reservation?.hniShares || 0),
                        retailShares: retailRow ? retailRow.shares : (existingData.reservation?.retailShares || 0),
                        shareholderShares: shRow ? shRow.shares : (existingData.reservation?.shareholderShares || 0),
                        employeeShares: empRow ? empRow.shares : (existingData.reservation?.employeeShares || 0),
                        anchorShares: anchorRow ? anchorRow.shares : (existingData.reservation?.anchorShares || 0),
                        totalShares: totalRow ? totalRow.shares : (existingData.reservation?.totalShares || 0),
                        breakdown: scrapedBreakdown
                    };
                }

                // Details & Lot Distribution: NEVER discard existing details!
                const details = {
                    ...(existingData.details || {}),
                    ...(ipo.details || {}),
                };
                if (ipo.detailed_info) {
                    if (ipo.detailed_info['About the Company']) details.about = ipo.detailed_info['About the Company'];
                    if (ipo.detailed_info['Strengths']) details.strengths = ipo.detailed_info['Strengths'];
                    if (ipo.detailed_info['Risk Factors']) details.risks = ipo.detailed_info['Risk Factors'];
                    if (ipo.detailed_info.lotDistribution) {
                        details.lotDistribution = {
                            ...(details.lotDistribution || {}),
                            ...ipo.detailed_info.lotDistribution
                        };
                    }
                }

                // Listing: capture debut prices from scraped listing table, preserve existing CMP & fields
                const scrapedListing = ipo.detailed_info?.listingData;
                const listing = {
                    ...(existingData.listing || {}),
                    ...(scrapedListing || {}),
                };

                // Final status & meta
                const shouldPublish = autoPublish || (existingData.meta?.published || false);
                let finalStatus = existingData.meta?.status;

                // If debut listing price was captured from the exchange table, status is definitely LISTED!
                if (scrapedListing && scrapedListing.listedPrice > 0) {
                    finalStatus = 'LISTED';
                } else if (shouldPublish && (!finalStatus || finalStatus.toUpperCase() === 'DRAFT')) {
                    finalStatus = 'UPCOMING';
                } else if (!finalStatus) {
                    finalStatus = 'DRAFT';
                }

                // Guard: if open date is in future, status MUST be UPCOMING, never OPEN!
                if (finalStatus === 'OPEN' && dates.open && new Date() < new Date(dates.open)) {
                    finalStatus = 'UPCOMING';
                }

                const meta = {
                    ...(existingData.meta || {}),
                    status: finalStatus,
                    published: shouldPublish,
                    lastUpdated: nowIso
                };

                // Subscription: preserve existing live-synced values and add rich breakdown if newly scraped
                const existingSub = existingData.subscription || {};
                let subscription = {
                    ...existingSub,
                    retail: existingSub.retail || 0,
                    hni: existingSub.hni || 0,
                    qib: existingSub.qib || 0,
                    total: existingSub.total || 0,
                };

                const scrapedSub = ipo.detailed_info?.subscriptionData;
                if (scrapedSub) {
                    // Update flat summary numbers from byShares if present, taking the higher / non-zero numbers
                    if (scrapedSub.byShares?.rows?.length > 0) {
                        const rows = scrapedSub.byShares.rows;
                        const findRow = (keywords) => rows.find(r => keywords.some(k => r.category.toLowerCase().includes(k.toLowerCase())));
                        const qibRow = findRow(['qib']);
                        const hniRow = findRow(['hni', 'nii']);
                        const retailRow = findRow(['retail', 'individual']);
                        const totalRow = findRow(['total']);
                        const empRow = findRow(['employee']);
                        const shRow = findRow(['shareholder']);

                        subscription = {
                            ...subscription,
                            retail: (retailRow && retailRow.times > 0) ? Math.max(retailRow.times, subscription.retail || 0) : (subscription.retail || 0),
                            hni: (hniRow && hniRow.times > 0) ? Math.max(hniRow.times, subscription.hni || 0) : (subscription.hni || 0),
                            qib: (qibRow && qibRow.times > 0) ? Math.max(qibRow.times, subscription.qib || 0) : (subscription.qib || 0),
                            total: (totalRow && totalRow.times > 0) ? Math.max(totalRow.times, subscription.total || 0) : (subscription.total || 0),
                            ...(empRow && empRow.times > 0 ? { employee: empRow.times } : (subscription.employee != null ? { employee: subscription.employee } : {})),
                            ...(shRow && shRow.times > 0 ? { shareholder: shRow.times } : (subscription.shareholder != null ? { shareholder: subscription.shareholder } : {})),
                        };
                    }

                    // Compute Allotment Chances
                    let allotmentChances = null;
                    if (scrapedSub.byApplications) {
                        const app = scrapedSub.byApplications;
                        const formatChance = (times) => {
                            if (!times || times <= 0) return { text: 'N/A', ratio: 0, percent: 0, isGuaranteed: false };
                            if (times <= 1.0) {
                                return { text: '100% Guaranteed', ratio: 1, percent: 100, isGuaranteed: true };
                            }
                            const ratio = Math.round(times);
                            const percent = Number(((1 / times) * 100).toFixed(2));
                            return {
                                text: `1 out of ${ratio}`,
                                ratio: ratio,
                                percent: percent,
                                isGuaranteed: false
                            };
                        };

                        allotmentChances = {
                            retail: formatChance(app.retail?.times || (app.retail?.reserved ? app.retail.applied / app.retail.reserved : 0)),
                            smallHni: formatChance(app.smallHni?.times || (app.smallHni?.reserved ? app.smallHni.applied / app.smallHni.reserved : 0)),
                            bigHni: formatChance(app.bigHni?.times || (app.bigHni?.reserved ? app.bigHni.applied / app.bigHni.reserved : 0))
                        };
                    }

                    subscription = {
                        ...subscription,
                        ...(scrapedSub.byApplications ? { byApplications: scrapedSub.byApplications } : (subscription.byApplications ? { byApplications: subscription.byApplications } : {})),
                        ...(scrapedSub.byAmount ? { byAmount: scrapedSub.byAmount } : (subscription.byAmount ? { byAmount: subscription.byAmount } : {})),
                        ...(scrapedSub.byShares ? { byShares: scrapedSub.byShares } : (subscription.byShares ? { byShares: subscription.byShares } : {})),
                        ...(scrapedSub.dayWise ? { dayWise: scrapedSub.dayWise } : (subscription.dayWise ? { dayWise: subscription.dayWise } : {})),
                        ...(allotmentChances ? { allotmentChances } : (subscription.allotmentChances ? { allotmentChances: subscription.allotmentChances } : {})),
                        lastUpdated: nowIso,
                        source: 'NSE/BSE'
                    };
                }

                // STRICT SUBSCRIPTION GUARD (Mainboard & SME):
                // An Upcoming IPO or an IPO whose open date is in the future CANNOT have subscription figures!
                const isUpcomingIpo = finalStatus === 'UPCOMING' || (dates.open && new Date() < new Date(dates.open));
                if (isUpcomingIpo) {
                    subscription = {
                        retail: 0,
                        hni: 0,
                        qib: 0,
                        total: 0,
                        employee: null,
                        shareholder: null,
                        byApplications: null,
                        byShares: null,
                        byAmount: null,
                        dayWise: null,
                        allotmentChances: null,
                        lastUpdated: nowIso
                    };
                }

                // Complete canonical object merged with existingData and newly scraped fields
                const finalData = {
                    ...existingData,     // 1. Preserves existing fields
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
                    listing,
                    subscription,
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

    // Automatically synchronize live subscription & allotment chances
    try {
        console.log("\n[MainScraper] Automatically triggering live subscription sync...");
        const { syncLiveSubscription } = require('./sync-live-subscription');
        await syncLiveSubscription();
    } catch (subErr) {
        console.error("[MainScraper] Failed to auto-sync live subscription:", subErr.message);
    }
}

scrapeIPO();
