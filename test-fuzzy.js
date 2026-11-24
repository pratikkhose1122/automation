const { isFuzzyMatch, cleanName } = require('./fuzzyMatch');

const testCases = [
    // CRITICAL: Negative tests that previously failed and caused the bug!
    { a: "A J Packaging Ltd.", b: "Knack Packaging Ltd.", expected: false },
    { a: "A J Packaging Ltd.", b: "Dhaval Packaging Ltd.", expected: false },
    { a: "Knack Packaging Ltd.", b: "Dhaval Packaging Ltd.", expected: false },
    { a: "Sun Pharma Ltd.", b: "Cipla Pharma Ltd.", expected: false },
    { a: "Tata Steel Ltd.", b: "JSW Steel Ltd.", expected: false },
    { a: "Tata Power Ltd.", b: "Adani Power Ltd.", expected: false },
    { a: "A R Solar Ltd.", b: "Waaree Solar Ltd.", expected: false },
    { a: "V K Foods Ltd.", b: "Haldiram Foods Ltd.", expected: false },
    { a: "S M Logistics Ltd.", b: "Blue Dart Logistics Ltd.", expected: false },
    { a: "A J Packaging Ltd.", b: "A K Packaging Ltd.", expected: false },
    
    // POSITIVE: True duplicates that SHOULD match
    { a: "A J Packaging Ltd.", b: "A. J. Packaging Limited", expected: true },
    { a: "A J Packaging Ltd.", b: "A J Packaging - SME IPO", expected: true },
    { a: "Knack Packaging Ltd.", b: "Knack Packaging Limited - SME", expected: true },
    { a: "Tata Technologies Ltd.", b: "Tata Technologies Limited", expected: true },
    { a: "Waaree Energies Ltd.", b: "Waaree Energies", expected: true },
    { a: "Swiggy Ltd.", b: "Swiggy Limited", expected: true },
    { a: "NTPC Green Energy Ltd.", b: "NTPC Green Energy", expected: true },
    { a: "Zomato Ltd.", b: "Zomato Limited - IPO", expected: true },
    { a: "Shree Siddhivinayak Greentech Ltd.", b: "Shree Siddhivinayak Greentech", expected: true },
];

let failed = 0;
console.log("Running fuzzyMatch test suite...\n");

for (const { a, b, expected } of testCases) {
    const result = isFuzzyMatch(a, b);
    const pass = result === expected;
    if (!pass) {
        failed++;
        console.error(`❌ FAILED: "${a}" ≈ "${b}" -> got ${result}, expected ${expected}`);
    } else {
        console.log(`✅ PASSED: "${a}" ≈ "${b}" -> ${result}`);
    }
}

if (failed === 0) {
    console.log(`\n🎉 ALL ${testCases.length} TESTS PASSED!`);
} else {
    console.error(`\n💥 ${failed} TESTS FAILED!`);
    process.exit(1);
}

