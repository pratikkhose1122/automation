/**
 * fuzzyMatch.js — Strict IPO name deduplication and fuzzy matching utility.
 * Prevents catastrophic false positives across companies sharing generic industry/sector terms.
 */

const GENERIC_INDUSTRY_WORDS = new Set([
    // Legal & Corporate forms
    'ltd', 'limited', 'pvt', 'private', 'llc', 'inc', 'corp', 'corporation', 'llp', 'co', 'company',
    // Market & Listing terms
    'ipo', 'sme', 'nse', 'bse', 'mainboard', 'reit', 'invit',
    // Stopwords
    'the', 'and', 'india', 'indian', 'bharat', 'national', 'group',
    // Generic Sector & Industry Nouns
    'packaging', 'packagers', 'packs',
    'technologies', 'technology', 'tech', 'infotech', 'software', 'solutions', 'systems', 'digital', 'cyber', 'data',
    'industries', 'industry', 'industrial',
    'enterprises', 'enterprise',
    'holdings', 'holding', 'ventures', 'venture',
    'services', 'service',
    'consultants', 'consultancy', 'consulting',
    'international', 'global', 'worldwide',
    'finance', 'financial', 'capital', 'wealth', 'investments', 'investment', 'securities', 'finvest', 'leasing',
    'infra', 'infrastructure', 'projects', 'project', 'constructions', 'construction', 'developers', 'properties', 'realty', 'estates', 'housing',
    'power', 'energy', 'solar', 'renewables', 'renewable', 'wind', 'green', 'clean', 'generation',
    'steel', 'steels', 'metals', 'metal', 'alloys', 'alloy', 'iron', 'minerals', 'mining', 'tubes', 'pipes',
    'pharma', 'pharmaceuticals', 'pharmaceutical', 'healthcare', 'health', 'lifesciences', 'therapeutics', 'laboratories', 'labs', 'biotech', 'biomedical',
    'chem', 'chemicals', 'chemical', 'organics', 'inorganics', 'petrochem', 'petrochemicals', 'specialities', 'specialties',
    'agro', 'agri', 'foods', 'food', 'beverages', 'grains', 'spices', 'exports', 'imports', 'impex', 'feeds',
    'logistics', 'shipping', 'maritime', 'transport', 'carriers', 'supply', 'chain', 'freight',
    'retail', 'consumer', 'commercial', 'products', 'goods', 'marketing',
    'jewels', 'jewellers', 'jewellery', 'gems', 'gold', 'diamonds',
    'engineering', 'engineers', 'machinery', 'tools', 'instruments', 'equipment',
    'textiles', 'fabrics', 'synthetics', 'polymers', 'fibres', 'yarns', 'garments', 'cotspin', 'apparels',
    'electronics', 'electricals', 'appliances', 'smart', 'automation',
    'communications', 'telecom', 'media', 'network', 'networks'
]);

function cleanName(name) {
    if (!name) return '';
    return name.toLowerCase()
        .replace(/\b(ltd\.?|limited|pvt\.?|private|llc|inc|corp|corporation|llp)\b/gi, '')
        .replace(/\s*-\s*(ipo|sme ipo|sme|bse sme|nse sme)$/gi, '')
        .replace(/(closing|open|closes)\s+today/gi, '')
        .replace(/\bnew\b/gi, '')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Calculates Levenshtein Distance between two strings.
 */
function levenshteinDistance(s1, s2) {
    const m = s1.length;
    const n = s2.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (s1[i - 1] === s2[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1];
            } else {
                dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
            }
        }
    }
    return dp[m][n];
}

/**
 * Calculates string similarity between 0.0 and 1.0.
 */
function stringSimilarity(s1, s2) {
    if (s1 === s2) return 1.0;
    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return 1.0;
    const dist = levenshteinDistance(s1, s2);
    return (maxLen - dist) / maxLen;
}

/**
 * Determines whether two company names refer to the same entity.
 * Strict rules guarantee that generic sector terms ("Packaging", "Steel", "Power")
 * can NEVER produce a false positive match across different companies.
 */
function isFuzzyMatch(a, b) {
    const cleanA = cleanName(a);
    const cleanB = cleanName(b);
    if (!cleanA || !cleanB) return false;

    // 1. Exact match after cleaning
    if (cleanA === cleanB) return true;

    const wordsA = cleanA.split(' ').filter(w => w.length > 0);
    const wordsB = cleanB.split(' ').filter(w => w.length > 0);

    // 2. Extract distinctive (non-generic) words
    const distinctiveA = wordsA.filter(w => !GENERIC_INDUSTRY_WORDS.has(w));
    const distinctiveB = wordsB.filter(w => !GENERIC_INDUSTRY_WORDS.has(w));

    // If either side has NO distinctive words, they MUST be an exact match to avoid generic clashes
    if (distinctiveA.length === 0 || distinctiveB.length === 0) {
        return cleanA === cleanB;
    }

    // 3. Initial-based companies (e.g. "a j", "v k", "s m")
    // When distinctive words contain initials (<= 2 chars), ALL initials must match exactly!
    const hasInitialsA = distinctiveA.some(w => w.length <= 2);
    const hasInitialsB = distinctiveB.some(w => w.length <= 2);

    if (hasInitialsA || hasInitialsB) {
        if (distinctiveA.length !== distinctiveB.length) return false;
        return distinctiveA.every((w, idx) => distinctiveB[idx] === w);
    }

    // 4. Distinctive Word Overlap Check
    const minDistinctiveCount = Math.min(distinctiveA.length, distinctiveB.length);

    // If both have 1 distinctive word (e.g. "Knack" vs "Dhaval", "Swiggy" vs "Swiggy")
    if (minDistinctiveCount === 1) {
        const da = distinctiveA[0];
        const db = distinctiveB[0];
        if (da === db) return true;
        // Allow minor typo in a single word only if length >= 5 and similarity >= 0.88
        if (da.length >= 5 && db.length >= 5 && stringSimilarity(da, db) >= 0.88) return true;
        return false;
    }

    // If both have multiple distinctive words (e.g. "Shree Siddhivinayak Greentech")
    let fuzzyDistinctiveMatchCount = 0;
    for (const wa of distinctiveA) {
        for (const wb of distinctiveB) {
            if (wa === wb || (wa.length >= 5 && wb.length >= 5 && stringSimilarity(wa, wb) >= 0.85)) {
                fuzzyDistinctiveMatchCount++;
                break;
            }
        }
    }

    // Require at least 2 distinctive words to match, and at least 66% of the shorter name's distinctive words
    const matchRatio = fuzzyDistinctiveMatchCount / minDistinctiveCount;
    return fuzzyDistinctiveMatchCount >= 2 && matchRatio >= 0.66;
}

module.exports = { cleanName, isFuzzyMatch, stringSimilarity, GENERIC_INDUSTRY_WORDS };
