/**
 * fuzzyMatch.js — Shared fuzzy matching utility for IPO name deduplication.
 * Used by scrape-ipo.js, cleanup-duplicates.js, and patch scripts.
 */

function cleanName(name) {
    if (!name) return '';
    return name.toLowerCase()
        .replace(/\b(ltd\.?|limited|pvt\.?|private)\b/g, '')
        .replace(/\s*-\s*(ipo|sme ipo|sme)$/g, '')
        .replace(/(closing|open|closes)\s+today/gi, '')
        .replace(/\bnew\b/gi, '')
        .replace(/[^a-z0-9 ]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isFuzzyMatch(a, b) {
    const cleanA = cleanName(a);
    const cleanB = cleanName(b);
    if (!cleanA || !cleanB) return false;

    // Direct substring containment
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

module.exports = { cleanName, isFuzzyMatch };
