require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const { createClient } = require('@supabase/supabase-js');

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

async function syncLiveSubscription() {
    console.log('[LiveSub] Starting targeted live subscription sync...');
    const now = new Date();
    const nowIso = now.toISOString();

    // 1. Fetch currently OPEN or recently active candidate IPOs
    const { data: rows, error } = await supabase.from('ipos').select('id, data');
    if (error) {
        console.error('[LiveSub] Supabase fetch error:', error);
        return;
    }

    const activeIpos = rows.filter(r => {
        const d = r.data || {};
        const meta = d.meta || {};
        const dates = d.dates || {};
        if (meta.published === false) return false;
        const status = String(meta.status || '').toUpperCase();
        if (status === 'OPEN') return true;
        if (dates.open && dates.close) {
            const o = new Date(dates.open);
            const c = new Date(dates.close);
            c.setHours(23, 59, 59, 999);
            if (now >= o && now <= c) return true;
        }
        return false;
    });

    console.log(`[LiveSub] Found ${activeIpos.length} active open IPO(s) for live subscription.`);
    if (activeIpos.length === 0) {
        console.log('[LiveSub] No open IPOs found at this time. Exiting.');
        return;
    }

    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        for (const ipoRecord of activeIpos) {
            const ipoData = ipoRecord.data || {};
            const detailUrl = ipoData.detail_url;
            const name = ipoData.basic?.name || ipoRecord.id;

            if (!detailUrl) {
                console.log(`[LiveSub] Skipping ${name} (no detail_url)`);
                continue;
            }

            console.log(`[LiveSub] Syncing live bidding for ${name} from ${detailUrl}...`);
            try {
                await page.goto(detailUrl, { waitUntil: 'networkidle2', timeout: 30000 });

                const scrapedSub = await page.evaluate(() => {
                    const tables = Array.from(document.querySelectorAll('table'));
                    let byShares = null;
                    let byApplications = null;
                    let byAmount = null;
                    let dayWise = null;

                    for (const t of tables) {
                        const trs = Array.from(t.querySelectorAll('tr'));
                        if (trs.length < 2) continue;
                        const headerCells = Array.from(trs[0].querySelectorAll('th, td')).map(c => c.innerText.trim().toUpperCase());

                        // Day-Wise Table
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
                            if (rows.length > 0) dayWise = rows;
                        }

                        // By Applications Table
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
                            if (Object.keys(appData).length > 0) byApplications = appData;
                        }

                        // By Amount vs By Shares
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
                                byAmount = { rows };
                            } else {
                                byShares = { rows };
                            }
                        }
                    }

                    return { byShares, byApplications, byAmount, dayWise };
                });

                if (scrapedSub && (scrapedSub.byShares || scrapedSub.byApplications || scrapedSub.byAmount)) {
                    let existingSub = ipoData.subscription || { retail: 0, hni: 0, qib: 0, total: 0 };

                    // Update flat multiples
                    if (scrapedSub.byShares?.rows?.length > 0) {
                        const rows = scrapedSub.byShares.rows;
                        const findRow = (keywords) => rows.find(r => keywords.some(k => r.category.toLowerCase().includes(k.toLowerCase())));
                        const qibRow = findRow(['qib']);
                        const hniRow = findRow(['hni', 'nii']);
                        const retailRow = findRow(['retail', 'individual']);
                        const totalRow = findRow(['total']);

                        existingSub = {
                            ...existingSub,
                            retail: retailRow ? retailRow.times : (existingSub.retail || 0),
                            hni: hniRow ? hniRow.times : (existingSub.hni || 0),
                            qib: qibRow ? qibRow.times : (existingSub.qib || 0),
                            total: totalRow ? totalRow.times : (existingSub.total || 0),
                        };
                    }

                    const allotmentChances = computeAllotmentChances(scrapedSub.byApplications);

                    const updatedSub = {
                        ...existingSub,
                        ...(scrapedSub.byApplications ? { byApplications: scrapedSub.byApplications } : {}),
                        ...(scrapedSub.byAmount ? { byAmount: scrapedSub.byAmount } : {}),
                        ...(scrapedSub.byShares ? { byShares: scrapedSub.byShares } : {}),
                        ...(scrapedSub.dayWise ? { dayWise: scrapedSub.dayWise } : {}),
                        ...(allotmentChances ? { allotmentChances } : {}),
                        lastUpdated: nowIso,
                        source: 'NSE/BSE'
                    };

                    const updatedData = {
                        ...ipoData,
                        subscription: updatedSub,
                        updated_at: nowIso
                    };

                    const { error: upsertErr } = await supabase
                        .from('ipos')
                        .upsert({
                            id: ipoRecord.id,
                            data: updatedData,
                            updated_at: nowIso
                        });

                    if (upsertErr) {
                        console.error(`[LiveSub] Error saving ${name}:`, upsertErr);
                    } else {
                        console.log(`[LiveSub] Successfully updated live subscription for ${name} (Total: ${updatedSub.total}x, Retail: ${updatedSub.retail}x)`);
                    }
                } else {
                    console.log(`[LiveSub] No new subscription tables found on page for ${name}.`);
                }
            } catch (err) {
                console.error(`[LiveSub] Failed to scrape ${name}:`, err.message);
            }
        }
    } finally {
        await browser.close();
        console.log('[LiveSub] Sync finished and browser closed.');
    }
}

if (require.main === module) {
    syncLiveSubscription();
}

module.exports = { syncLiveSubscription };
