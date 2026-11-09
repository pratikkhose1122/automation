/**
 * cleanup-duplicates.js
 * 
 * One-time script to find and merge duplicate IPOs in the Supabase database.
 * Duplicates are identified by fuzzy-matching company names.
 * The "winner" (most complete data) is kept; the "loser" is deleted.
 * 
 * Usage:
 *   node cleanup-duplicates.js --dry-run   (preview only, no deletes)
 *   node cleanup-duplicates.js             (actually merge & delete)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const isDryRun = process.argv.includes('--dry-run');

// ============================================================
// Fuzzy Matching (same algorithm as allotment_service.dart)
// ============================================================
function cleanName(name) {
    if (!name) return '';
    return name.toLowerCase()
        .replace(/\b(ltd\.?|limited|pvt\.?|private)\b/g, '')
        .replace(/\s*-\s*(ipo|sme ipo|sme)$/g, '')
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isFuzzyMatch(a, b) {
    const cleanA = cleanName(a);
    const cleanB = cleanName(b);
    if (!cleanA || !cleanB) return false;

    // Direct substring
    if (cleanA.includes(cleanB) || cleanB.includes(cleanA)) return true;

    // Word overlap
    const skipWords = new Set(['the', 'and', 'india', 'ipo', 'sme', 'nse', 'bse']);
    const wordsA = cleanA.split(' ').filter(w => w.length > 2 && !skipWords.has(w));
    const wordsB = cleanB.split(' ').filter(w => w.length > 2 && !skipWords.has(w));
    if (wordsA.length === 0 || wordsB.length === 0) return false;

    const matchCount = wordsA.filter(w => wordsB.includes(w)).length;
    if (wordsA.length === 1 || wordsB.length === 1) return matchCount >= 1;
    return matchCount >= 2 && matchCount >= Math.ceil(wordsA.length / 2);
}

// ============================================================
// Data Completeness Score
// ============================================================
function dataScore(row) {
    const data = row.data || {};
    const dates = data.dates || {};
    const pricing = data.pricing || {};
    const issue = data.issue || {};
    const basic = data.basic || {};
    const meta = data.meta || {};
    let score = 0;

    if (dates.open) score += 10;
    if (dates.close) score += 10;
    if (parseFloat(pricing.maxPrice) > 0) score += 5;
    if (parseFloat(issue.totalIssueCr) > 0) score += 5;
    if (parseInt(pricing.lotSize) > 0) score += 3;
    if (basic.logoUrl && basic.logoUrl.trim()) score += 2;
    if (meta.published === true) score += 5;  // Prefer published entries
    if (data.detailed_info) score += 3;        // Has deep-scraped details
    if (data.subscription && Object.keys(data.subscription).length > 0) score += 2;
    
    return score;
}

// ============================================================
// Main
// ============================================================
async function main() {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`IPO Duplicate Cleanup ${isDryRun ? '[DRY RUN]' : '[LIVE MODE]'}`);
    console.log(`${'='.repeat(50)}\n`);

    // 1. Fetch all IPOs
    const { data: rows, error } = await supabase.from('ipos').select('*');
    if (error) {
        console.error('Failed to fetch IPOs:', error);
        process.exit(1);
    }

    console.log(`Total IPOs in database: ${rows.length}\n`);

    // 2. Extract names
    const ipos = rows.map(row => ({
        id: row.id,
        name: (row.data?.basic?.name || row.data?.COMPANY || row.company_name || row.id || '').trim(),
        score: dataScore(row),
        status: row.data?.meta?.status || 'UNKNOWN',
        published: row.data?.meta?.published || false,
        hasOpenDate: !!(row.data?.dates?.open),
        row: row,
    }));

    // 3. Find duplicate groups
    const used = new Set();
    const duplicateGroups = [];

    for (let i = 0; i < ipos.length; i++) {
        if (used.has(i)) continue;
        
        const group = [ipos[i]];
        
        for (let j = i + 1; j < ipos.length; j++) {
            if (used.has(j)) continue;

            if (isFuzzyMatch(ipos[i].name, ipos[j].name)) {
                group.push(ipos[j]);
                used.add(j);
            }
        }

        if (group.length > 1) {
            duplicateGroups.push(group);
        }
    }

    if (duplicateGroups.length === 0) {
        console.log('✅ No duplicates found! Database is clean.');
        return;
    }

    console.log(`Found ${duplicateGroups.length} duplicate group(s):\n`);

    let totalDeleted = 0;

    for (const group of duplicateGroups) {
        // Sort by score descending — best entry first
        group.sort((a, b) => b.score - a.score);
        const winner = group[0];
        const losers = group.slice(1);

        console.log(`─── Duplicate Group ───`);
        console.log(`  WINNER: "${winner.name}" (id: ${winner.id}, score: ${winner.score}, status: ${winner.status}, published: ${winner.published}, dates: ${winner.hasOpenDate})`);
        for (const loser of losers) {
            console.log(`  LOSER:  "${loser.name}" (id: ${loser.id}, score: ${loser.score}, status: ${loser.status}, published: ${loser.published}, dates: ${loser.hasOpenDate})`);
        }

        if (!isDryRun) {
            for (const loser of losers) {
                const { error: delError } = await supabase.from('ipos').delete().eq('id', loser.id);
                if (delError) {
                    console.log(`  ❌ Failed to delete "${loser.name}": ${delError.message}`);
                } else {
                    console.log(`  🗑️  Deleted "${loser.name}" (id: ${loser.id})`);
                    totalDeleted++;
                }
            }
        } else {
            for (const loser of losers) {
                console.log(`  [DRY RUN] Would delete "${loser.name}" (id: ${loser.id})`);
                totalDeleted++;
            }
        }
        console.log('');
    }

    console.log(`${'='.repeat(50)}`);
    console.log(`Summary: ${duplicateGroups.length} groups, ${totalDeleted} duplicates ${isDryRun ? 'would be' : ''} deleted.`);
    console.log(`${'='.repeat(50)}\n`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
