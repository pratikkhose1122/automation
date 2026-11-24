require('dotenv').config();
const https = require('https');
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
const { isFuzzyMatch } = require('./fuzzyMatch');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ============================================================
// Lightweight HTTP helpers (no Puppeteer — pure Node.js HTTP)
// ============================================================

function httpPost(url, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                ...headers,
            },
            timeout: 8000,
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

function httpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const options = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,*/*',
                ...headers,
            },
            timeout: 8000,
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
        req.end();
    });
}

// ============================================================
// Registrar Polling — Query dropdowns directly
// ============================================================

/**
 * MUFG / Link Intime: POST /IPO.aspx/GetDetails → XML with <company_id> + <companyname>
 * Returns array of { name, id, registrar, portalUrl }
 */
async function pollLinkIntime() {
    try {
        const resp = await httpPost(
            'https://in.mpms.mufg.com/Initial_Offer/IPO.aspx/GetDetails',
            '{}',
            {
                'Referer': 'https://in.mpms.mufg.com/Initial_Offer/public-issues.html',
                'X-Requested-With': 'XMLHttpRequest',
            }
        );
        if (resp.status !== 200) return [];

        const json = JSON.parse(resp.body);
        const xmlStr = json.d || '';
        const regex = /<company_id>(\d+)<\/company_id>\s*<companyname>([^<]+)<\/companyname>/gi;
        const results = [];
        let match;
        while ((match = regex.exec(xmlStr)) !== null) {
            results.push({
                name: match[2].trim(),
                id: match[1],
                registrar: 'Link Intime',
                portalUrl: 'https://in.mpms.mufg.com/Initial_Offer/public-issues.html',
            });
        }
        console.log(`  [LinkIntime] Found ${results.length} active IPOs in dropdown`);
        return results;
    } catch (err) {
        console.error(`  [LinkIntime] Error: ${err.message}`);
        return [];
    }
}

/**
 * KFintech: GET index page → find main.[hash].js → parse JSON.parse('[{clientId:...}]')
 * Returns array of { name, id, registrar, portalUrl }
 */
async function pollKFintech() {
    try {
        const indexResp = await httpGet('https://ipostatus.kfintech.com/', { 'Accept': 'text/html' });
        if (indexResp.status !== 200) return [];

        // Find main bundle script
        const scriptMatch = indexResp.body.match(/src="\.?(\/static\/js\/main\.[a-f0-9]+\.js)"/);
        if (!scriptMatch) {
            // Fallback: check HTML for <option> tags
            return parseKFintechFromHtml(indexResp.body);
        }

        const jsUrl = `https://ipostatus.kfintech.com${scriptMatch[1]}`;
        const jsResp = await httpGet(jsUrl, { 'Accept': '*/*' });
        if (jsResp.status !== 200) return parseKFintechFromHtml(indexResp.body);

        const startMarker = "JSON.parse('[{\"clientId\":";
        const startIdx = jsResp.body.indexOf(startMarker);
        if (startIdx === -1) return parseKFintechFromHtml(indexResp.body);

        const endIdx = jsResp.body.indexOf("]')", startIdx);
        if (endIdx === -1) return parseKFintechFromHtml(indexResp.body);

        const jsonStr = jsResp.body.substring(startIdx + "JSON.parse('".length, endIdx + 1);
        const decoded = JSON.parse(jsonStr);
        const results = decoded
            .filter(item => item.clientId && item.name)
            .map(item => ({
                name: item.name.trim(),
                id: item.clientId.toString(),
                registrar: 'KFintech',
                portalUrl: 'https://ipostatus.kfintech.com/',
            }));

        console.log(`  [KFintech] Found ${results.length} active IPOs in JS bundle`);
        return results;
    } catch (err) {
        console.error(`  [KFintech] Error: ${err.message}`);
        return [];
    }
}

function parseKFintechFromHtml(html) {
    const regex = /<option\s+value="([^"]+)"[^>]*>([^<]+)<\/option>/gi;
    const results = [];
    let match;
    while ((match = regex.exec(html)) !== null) {
        const val = match[1].trim();
        const name = match[2].trim();
        if (!val || val === '0' || val === 'Select Company') continue;
        results.push({
            name,
            id: val,
            registrar: 'KFintech',
            portalUrl: 'https://ipostatus.kfintech.com/',
        });
    }
    console.log(`  [KFintech] Found ${results.length} active IPOs in HTML fallback`);
    return results;
}

/**
 * BigShare: GET /IPO_Status.html → parse <option value="ID">Name</option>
 * Checks all 3 BigShare servers.
 * Returns array of { name, id, registrar, portalUrl }
 */
async function pollBigShare() {
    const servers = [
        'https://ipo.bigshareonline.com',
        'https://ipo1.bigshareonline.com',
        'https://ipo2.bigshareonline.com',
    ];

    const allResults = [];
    const seenNames = new Set();

    for (const server of servers) {
        try {
            const resp = await httpGet(`${server}/IPO_Status.html`);
            if (resp.status !== 200) continue;

            const regex = /<option\s+value="(\d+)"[^>]*>([^<]+)<\/option>/gi;
            let match;
            while ((match = regex.exec(resp.body)) !== null) {
                const val = match[1].trim();
                const name = match[2].trim();
                if (val === '0') continue;
                const key = name.toUpperCase();
                if (seenNames.has(key)) continue;
                seenNames.add(key);
                allResults.push({
                    name,
                    id: val,
                    registrar: 'BigShare',
                    portalUrl: `${server}/IPO_Status.html`,
                });
            }
        } catch (err) {
            // Skip failed server, try next
        }
    }

    console.log(`  [BigShare] Found ${allResults.length} active IPOs across ${servers.length} servers`);
    return allResults;
}

// ============================================================
// Main: Poll all registrars, match against DB, patch Supabase
// ============================================================

async function main() {
    console.log('=== Direct Registrar Allotment Poller ===');
    console.log(`Time: ${new Date().toISOString()}\n`);

    // 1. Fetch all published IPOs from Supabase that need allotment detection
    const { data: allIpos, error } = await supabase.from('ipos').select('id, data');
    if (error) {
        console.error('Supabase fetch error:', error);
        process.exit(1);
    }

    const now = new Date();
    const candidates = allIpos.filter(row => {
        const d = row.data;
        if (!d?.meta?.published) return false;

        // Must be Closed status (subscription ended, not yet listed)
        const status = (d.meta?.status || '').toLowerCase();
        if (status !== 'closed') return false;

        // allotmentLink must be empty or null
        const link = d.details?.registrarDetails?.allotmentLink || '';
        if (link.length > 0) return false;

        // Allotment date must be today or in the past
        const allotmentStr = d.dates?.allotment;
        if (!allotmentStr) return false;

        const allotmentDate = new Date(allotmentStr);
        // Compare date only (ignore time), allotment day or past
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const allotmentDayStart = new Date(allotmentDate.getFullYear(), allotmentDate.getMonth(), allotmentDate.getDate());

        return allotmentDayStart <= todayStart;
    });

    if (candidates.length === 0) {
        console.log('No IPOs pending allotment detection. All good!');
        return;
    }

    console.log(`Found ${candidates.length} IPO(s) needing allotment detection:\n`);
    for (const c of candidates) {
        console.log(`  - ${c.data.basic?.name || c.id} (allotment: ${c.data.dates?.allotment})`);
    }
    console.log('');

    // 2. Poll all 3 registrars in parallel
    console.log('Polling registrar dropdown APIs...');
    const [linkIntimeIPOs, kfintechIPOs, bigShareIPOs] = await Promise.all([
        pollLinkIntime(),
        pollKFintech(),
        pollBigShare(),
    ]);

    const allRegistrarIPOs = [...linkIntimeIPOs, ...kfintechIPOs, ...bigShareIPOs];
    console.log(`\nTotal registrar entries: ${allRegistrarIPOs.length}\n`);

    if (allRegistrarIPOs.length === 0) {
        console.log('No registrar data available. Registrar endpoints may be down.');
        return;
    }

    // 3. Match each candidate against registrar dropdowns using fuzzy matching
    let patchCount = 0;

    for (const candidate of candidates) {
        const ipoName = candidate.data.basic?.name || '';
        if (!ipoName) continue;

        // Find first matching registrar entry
        const matched = allRegistrarIPOs.find(reg => isFuzzyMatch(ipoName, reg.name));

        if (matched) {
            console.log(`✅ MATCH: "${ipoName}" ↔ "${matched.name}" [${matched.registrar}]`);

            // Patch Supabase
            const updatedData = { ...candidate.data };
            if (!updatedData.details) updatedData.details = {};
            if (!updatedData.details.registrarDetails) updatedData.details.registrarDetails = {};

            updatedData.details.registrarDetails.allotmentLink = matched.portalUrl;
            updatedData.basic.registrar = matched.registrar;

            // Add allotment detection metadata
            if (!updatedData.meta) updatedData.meta = {};
            updatedData.meta.allotmentDeclaredAt = new Date().toISOString();
            updatedData.meta.updatedAt = new Date().toISOString();

            const { error: updateError } = await supabase
                .from('ipos')
                .update({ data: updatedData })
                .eq('id', candidate.id);

            if (updateError) {
                console.error(`  ❌ Failed to patch ${candidate.id}:`, updateError);
            } else {
                console.log(`  → Patched ${candidate.id}: allotmentLink="${matched.portalUrl}", registrar="${matched.registrar}"`);
                patchCount++;

                // Send FCM push notification (if FCM_SERVER_KEY is configured)
                await sendFcmNotification(ipoName, candidate.id);
            }
        } else {
            console.log(`⏳ No match yet: "${ipoName}" — registrar hasn't released allotment`);
        }
    }

    console.log(`\n=== Done. Patched ${patchCount} IPO(s). ===`);
}

// ============================================================
// FCM Push Notification (optional — fires if FCM key is set)
// ============================================================

async function sendFcmNotification(ipoName, ipoId) {
    const serverKey = process.env.FCM_SERVER_KEY;
    if (!serverKey) {
        console.log('  (FCM_SERVER_KEY not set, skipping push notification)');
        return;
    }

    try {
        const resp = await httpPost(
            'https://fcm.googleapis.com/fcm/send',
            JSON.stringify({
                to: '/topics/allotment_released',
                notification: {
                    title: '🎯 Allotment Out!',
                    body: `${ipoName} allotment is live. Check your status now!`,
                },
                data: {
                    ipoId: ipoId,
                    action: 'check_allotment',
                },
            }),
            {
                'Authorization': `key=${serverKey}`,
                'Content-Type': 'application/json',
            }
        );
        console.log(`  📲 FCM push sent (status: ${resp.status})`);
    } catch (err) {
        console.error(`  ⚠️ FCM push failed: ${err.message}`);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

