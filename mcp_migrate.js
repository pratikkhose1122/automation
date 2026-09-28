require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Initialize Supabase
const supabaseUrl = 'https://jhoyxtwvkbjbqkdypqcu.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!supabaseKey) {
    console.error('Please set SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY in .env');
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// Convert Firestore REST value to standard JS value
function parseFirestoreValue(value) {
    if (!value) return null;
    if (value.stringValue !== undefined) return value.stringValue;
    if (value.integerValue !== undefined) return parseInt(value.integerValue, 10);
    if (value.doubleValue !== undefined) return parseFloat(value.doubleValue);
    if (value.booleanValue !== undefined) return value.booleanValue;
    if (value.nullValue !== undefined) return null;
    if (value.timestampValue !== undefined) return value.timestampValue;
    if (value.mapValue !== undefined && value.mapValue.fields) {
        const obj = {};
        for (const [k, v] of Object.entries(value.mapValue.fields)) {
            obj[k] = parseFirestoreValue(v);
        }
        return obj;
    }
    if (value.arrayValue !== undefined && value.arrayValue.values) {
        return value.arrayValue.values.map(v => parseFirestoreValue(v));
    }
    if (value.arrayValue !== undefined) return [];
    if (value.referenceValue !== undefined) return value.referenceValue;
    return value; // fallback
}

function parseFirestoreDoc(doc) {
    const id = doc.name.split('/').pop();
    const data = {};
    if (doc.fields) {
        for (const [k, v] of Object.entries(doc.fields)) {
            data[k] = parseFirestoreValue(v);
        }
    }
    return { id, data };
}

async function migrateCollection(tableName, jsonFilePath) {
    console.log(`\nMigrating collection to table: ${tableName}`);
    if (!fs.existsSync(jsonFilePath)) {
        console.log(`File ${jsonFilePath} not found, skipping.`);
        return;
    }
    const rawData = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
    let docs = [];
    if (Array.isArray(rawData)) {
        docs = rawData;
    } else if (rawData.documents) {
        docs = rawData.documents;
    }

    if (docs.length === 0) {
        console.log(`No documents found for ${tableName}.`);
        return;
    }

    let successCount = 0;
    let errorCount = 0;

    for (const doc of docs) {
        const parsed = parseFirestoreDoc(doc);
        const { error } = await supabase
            .from(tableName)
            .upsert({
                id: parsed.id,
                data: parsed.data
            });

        if (error) {
            console.error(`Error migrating doc ${parsed.id}:`, error);
            errorCount++;
        } else {
            successCount++;
        }
    }

    console.log(`Completed ${tableName}: ${successCount} successful, ${errorCount} failed.`);
}

async function main() {
    console.log('Starting migration from MCP dumps...');
    
    // Parse IPOS
    await migrateCollection('ipos', 'C:/Users/prati/.gemini/antigravity-ide/brain/34024a7f-140d-4c9f-a0a8-6a2015cf6240/.system_generated/steps/291/output.txt');
    
    // Parse ISSUE_IDS
    await migrateCollection('issue_ids', 'C:/Users/prati/.gemini/antigravity-ide/brain/34024a7f-140d-4c9f-a0a8-6a2015cf6240/.system_generated/steps/321/output.txt');
    
    // Process other collections
    const otherDataPath = 'C:/Users/prati/AndroidStudioProjects/automation/other_data.json';
    if (fs.existsSync(otherDataPath)) {
        const otherData = JSON.parse(fs.readFileSync(otherDataPath, 'utf8'));
        
        for (const [colName, docs] of Object.entries(otherData)) {
            // Write to temporary file so migrateCollection can use it
            const tempFile = `temp_${colName}.json`;
            fs.writeFileSync(tempFile, JSON.stringify(docs));
            await migrateCollection(colName, tempFile);
            fs.unlinkSync(tempFile);
        }
    }
    
    console.log('\nAll MCP data migrations complete!');
}

main().catch(console.error);
