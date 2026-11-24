require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { createClient } = require('@supabase/supabase-js');
const { cleanName, isFuzzyMatch } = require('./fuzzyMatch');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jhoyxtwvkbjbqkdypqcu.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function parseCleanNum(val) {
    if (!val) return 0;
    const cleaned = String(val).replace(/₹|,/g, '').trim();
    if (cleaned === '-' || cleaned === '--' || !cleaned) return 0;
    return parseFloat(cleaned) || 0;
}

function parseCleanInt(val) {
    if (!val) return 0;
    const cleaned = String(val).replace(/[^\d]/g, '').trim();
    return parseInt(cleaned, 10) || 0;
}

function computeAllotmentChances(byApplications) {
    if (!byApplications) return null;
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

    return {
        retail: formatChance(byApplications.retail?.times || (byApplications.retail?.reserved ? byApplications.retail.applied / byApplications.retail.reserved : 0)),
        smallHni: formatChance(byApplications.smallHni?.times || (byApplications.smallHni?.reserved ? byApplications.smallHni.applied / byApplications.smallHni.reserved : 0)),
        bigHni: formatChance(byApplications.bigHni?.times || (byApplications.bigHni?.reserved ? byApplications.bigHni.applied / byApplications.bigHni.reserved : 0))
    };
}

async function scrapeSubscriptionPage() {
    console.log('[LiveSub] Launching browser to scrape https://www.ipopremium.in/view/subscription ...');
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await page.goto('https://www.ipopremium.in/view/subscription', { waitUntil: 'networkidle2', timeout: 35000 });

        const cardsData = await page.evaluate(() => {
            const headings = Array.from(document.querySelectorAll('h4')).filter(h => h.innerText.trim());
            const results = [];

            for (const h of headings) {
                const rawName = h.innerText.trim();
                let parent = h.parentElement;
                while (parent && parent.querySelectorAll('table').length < 2 && parent !== document.body) {
                    parent = parent.parentElement;
                }
                if (!parent || parent === document.body) continue;

                const tables = Array.from(parent.querySelectorAll('table'));
                let sharesTable = null;
                let appsTable = null;
                let amountTable = null;

                for (const t of tables) {
                    const trs = Array.from(t.querySelectorAll('tr')).map(r => Array.from(r.querySelectorAll('th, td')).map(c => c.innerText.trim()));
                    if (trs.length < 2) continue;
                    const hRow = trs[0].map(c => c.toUpperCase());

                    if (hRow.includes('OFFERED') && hRow.includes('APPLIED') && hRow.includes('TIMES')) {
                        const sampleVal = trs[1] && trs[1][1] ? trs[1][1] : '';
                        if (sampleVal.includes('.') && parseFloat(sampleVal.replace(/,/g, '')) < 50000) {
                            amountTable = trs;
                        } else if (!sharesTable) {
                            sharesTable = trs;
                        }
                    } else if (hRow.includes('RESERVED') && (hRow.includes('APPLIED') || hRow.includes('APPLICATIONS'))) {
                        appsTable = trs;
                    } else if (hRow.includes('DEMAND') || (hRow.includes('OFFERED') && amountTable === null)) {
                        amountTable = trs;
                    }
                }

                results.push({ rawName, sharesTable, appsTable, amountTable });
            }
            return results;
        });

        return cardsData;
    } finally {
        await browser.close();
    }
}

async function syncLiveSubscription() {
    console.log('[LiveSub] Starting real-time subscription synchronization...');
    const nowIso = new Date().toISOString();

    // 1. Scrape the central subscription dashboard
    let cards = [];
    try {
        cards = await scrapeSubscriptionPage();
        console.log(`[LiveSub] Scraped ${cards.length} IPO cards from subscription dashboard.`);
    } catch (err) {
        console.error('[LiveSub] Failed to scrape subscription dashboard:', err.message);
        return;
    }

    if (cards.length === 0) {
        console.log('[LiveSub] No IPO cards found on subscription page.');
        return;
    }

    // 2. Fetch all IPOs from Supabase
    const { data: allRows, error: fetchErr } = await supabase.from('ipos').select('id, data');
    if (fetchErr) {
        console.error('[LiveSub] Failed to fetch Supabase rows:', fetchErr);
        return;
    }

    console.log(`[LiveSub] Fetched ${allRows.length} IPO records from Supabase.`);

    for (const card of cards) {
        const { rawName, sharesTable, appsTable, amountTable } = card;
        const cleanCardName = cleanName(rawName);

        // Find matching row in Supabase
        let matchedRow = null;

        // Try exact / clean match first
        for (const row of allRows) {
            const rowName = row.data?.basic?.name || row.data?.COMPANY || '';
            const cleanRowName = cleanName(rowName);
            if (cleanCardName && cleanRowName && cleanCardName === cleanRowName) {
                matchedRow = row;
                break;
            }
        }

        // Fallback to fuzzy match
        if (!matchedRow) {
            for (const row of allRows) {
                const rowName = row.data?.basic?.name || row.data?.COMPANY || '';
                if (rowName && isFuzzyMatch(rawName, rowName)) {
                    matchedRow = row;
                    break;
                }
            }
        }

        // Fallback to slug match
        if (!matchedRow) {
            const slug = cleanCardName.replace(/\s+/g, '-');
            for (const row of allRows) {
                if (row.id.includes(slug)) {
                    matchedRow = row;
                    break;
                }
            }
        }

        if (!matchedRow) {
            console.log(`[LiveSub] No Supabase match found for "${rawName}" (clean: "${cleanCardName}")`);
            continue;
        }

        const ipoData = matchedRow.data || {};
        const matchedName = ipoData.basic?.name || matchedRow.id;

        // STRICT UPCOMING GUARD: Never sync live subscription into an Upcoming or Future-open IPO!
        const metaStatus = (ipoData.meta?.status || '').toUpperCase();
        const openStr = ipoData.dates?.open;
        const openDate = openStr ? new Date(openStr) : null;
        const isUpcoming = metaStatus === 'UPCOMING' || (openDate && openDate > new Date());
        if (isUpcoming) {
            console.log(`[LiveSub] 🛡️ Guard: Skipping Upcoming IPO "${matchedName}" (${matchedRow.id}) — Upcoming IPOs cannot have subscription!`);
            continue;
        }

        console.log(`\n[LiveSub] Processing match: "${rawName}" -> "${matchedName}" (ID: ${matchedRow.id})`);

        // Parse By Shares Table
        let flatRetail = 0;
        let flatHni = 0;
        let flatQib = 0;
        let flatTotal = 0;
        let flatEmployee = null;
        let flatShareholder = null;
        let byShares = null;

        if (sharesTable && sharesTable.length > 1) {
            const rows = [];
            for (let r = 1; r < sharesTable.length; r++) {
                const cells = sharesTable[r];
                if (cells.length < 4) continue;
                const cat = cells[0];
                const offered = parseCleanNum(cells[1]);
                const appliedOrDemand = parseCleanNum(cells[2]);
                const times = parseCleanNum(cells[3]);

                const catLower = cat.toLowerCase();
                if (catLower.includes('qib')) {
                    flatQib = times;
                } else if (catLower === 'hnis' || catLower === 'hni' || catLower.includes('nii')) {
                    flatHni = times;
                } else if (catLower.includes('retail') || catLower.includes('individual')) {
                    flatRetail = times;
                } else if (catLower.includes('total')) {
                    flatTotal = times;
                } else if (catLower.includes('employee')) {
                    flatEmployee = times;
                } else if (catLower.includes('shareholder')) {
                    flatShareholder = times;
                }

                rows.push({ category: cat, offered, appliedOrDemand, times });
            }
            if (rows.length > 0) {
                byShares = { rows };
            }
        }

        // Parse By Applications Table
        let byApplications = null;
        if (appsTable && appsTable.length > 1) {
            const appData = {};
            for (let r = 1; r < appsTable.length; r++) {
                const cells = appsTable[r];
                if (cells.length < 4) continue;
                const catLower = cells[0].toLowerCase();
                const reserved = parseCleanInt(cells[1]);
                const applied = parseCleanInt(cells[2]);
                const times = parseCleanNum(cells[3]);

                if (catLower.includes('10l+') || catLower.includes('bhni') || catLower.includes('big hni')) {
                    appData.bigHni = { reserved, applied, times };
                } else if (catLower.includes('2-10l') || catLower.includes('3-10l') || catLower.includes('shni') || catLower.includes('small hni') || catLower.includes('2+')) {
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
                byApplications = appData;
            }
        }

        // Parse By Amount Table
        let byAmount = null;
        if (amountTable && amountTable.length > 1) {
            const rows = [];
            for (let r = 1; r < amountTable.length; r++) {
                const cells = amountTable[r];
                if (cells.length < 4) continue;
                const cat = cells[0];
                const offered = parseCleanNum(cells[1]);
                const appliedOrDemand = parseCleanNum(cells[2]);
                const times = parseCleanNum(cells[3]);

                rows.push({ category: cat, offered, appliedOrDemand, times });
            }
            if (rows.length > 0) {
                byAmount = { rows };
            }
        }

        const allotmentChances = computeAllotmentChances(byApplications);

        const existingSub = ipoData.subscription || {};
        const updatedSub = {
            ...existingSub,
            retail: flatRetail || existingSub.retail || 0,
            hni: flatHni || existingSub.hni || 0,
            qib: flatQib || existingSub.qib || 0,
            total: flatTotal || existingSub.total || 0,
            ...(flatEmployee !== null ? { employee: flatEmployee } : {}),
            ...(flatShareholder !== null ? { shareholder: flatShareholder } : {}),
            ...(byShares ? { byShares } : {}),
            ...(byApplications ? { byApplications } : {}),
            ...(byAmount ? { byAmount } : {}),
            ...(allotmentChances ? { allotmentChances } : {}),
            lastUpdated: nowIso,
            source: 'NSE / BSE'
        };

        const updatedData = {
            ...ipoData,
            subscription: updatedSub,
            updated_at: nowIso
        };

        const { error: upsertErr } = await supabase
            .from('ipos')
            .upsert({
                id: matchedRow.id,
                data: updatedData,
                updated_at: nowIso
            });

        if (upsertErr) {
            console.error(`[LiveSub] Error upserting ${matchedName}:`, upsertErr);
        } else {
            console.log(`[LiveSub] SUCCESS! Synced "${matchedName}" (Total: ${updatedSub.total}x, Retail: ${updatedSub.retail}x, HNI: ${updatedSub.hni}x, QIB: ${updatedSub.qib}x)`);
            if (allotmentChances) {
                console.log(`          Chances -> Retail: ${allotmentChances.retail?.text}, Small HNI: ${allotmentChances.smallHni?.text}, Big HNI: ${allotmentChances.bigHni?.text}`);
            }
        }
    }

    console.log('\n[LiveSub] All active IPO subscriptions synchronized successfully.');
}

if (require.main === module) {
    syncLiveSubscription();
}

module.exports = { syncLiveSubscription };
