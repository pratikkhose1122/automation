const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

if (!getApps().length) {
    initializeApp();
}

const db = getFirestore();

// Initialize Supabase
const supabaseUrl = 'https://jhoyxtwvkbjbqkdypqcu.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impob3l4dHd2a2JqYnFrZHlwcWN1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyNDQzMTQsImV4cCI6MjA5ODgyMDMxNH0.2pxtwGmMGNG1lGrjAUsDbHqEmqxpPisk3dgEnwk74wU'; // You can use the service_role key here for bypassing RLS during migration if needed
const supabase = createClient(supabaseUrl, supabaseKey);

async function migrateCollection(collectionName, tableName, mapFn = (id, data) => ({ id, data })) {
    console.log(`\nMigrating collection '${collectionName}' to table '${tableName}'...`);
    const snapshot = await db.collection(collectionName).get();
    
    if (snapshot.empty) {
        console.log(`No documents found in ${collectionName}.`);
        return;
    }

    const batchSize = 100;
    let rows = [];

    for (const doc of snapshot.docs) {
        rows.push(mapFn(doc.id, doc.data()));
        
        if (rows.length === batchSize) {
            await insertToSupabase(tableName, rows);
            rows = [];
        }
    }

    if (rows.length > 0) {
        await insertToSupabase(tableName, rows);
    }

    console.log(`Successfully migrated ${snapshot.size} documents from ${collectionName}.`);
}

async function insertToSupabase(tableName, rows) {
    const { error } = await supabase.from(tableName).upsert(rows);
    if (error) {
        console.error(`Error inserting into ${tableName}:`, error);
    } else {
        process.stdout.write('.');
    }
}

async function main() {
    try {
        // Migrate IPOs
        await migrateCollection('ipos', 'ipos');
        
        // Migrate Registrars
        await migrateCollection('registrars', 'registrars', (id, data) => ({
            id,
            name: data.name || '',
            is_active: data.isActive !== undefined ? data.isActive : true,
            data
        }));
        
        // Migrate Issue IDs
        await migrateCollection('issue_ids', 'issue_ids', (id, data) => ({
            id,
            ipo_id: data.ipoId || null,
            registrar_id: data.registrarId || null,
            is_active: data.isActive !== undefined ? data.isActive : true,
            data
        }));

        // Migrate App Config
        await migrateCollection('app_config', 'app_config');

        // Migrate Announcements
        await migrateCollection('announcements', 'announcements');

        // Migrate Feature Flags
        await migrateCollection('feature_flags', 'feature_flags');

        console.log('\nMigration completed successfully!');
    } catch (e) {
        console.error('Migration failed:', e);
    }
}

main();
