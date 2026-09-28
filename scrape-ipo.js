require('dotenv').config();
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function scrapeIPO() {
    console.log("Starting headless browser...");
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    
    try {
        const page = await browser.newPage();
        
        console.log("Navigating to https://www.ipopremium.in/ ...");
        await page.goto('https://www.ipopremium.in/', { waitUntil: 'networkidle2', timeout: 60000 });
        
        console.log("Extracting table data...");
        const tablesData = await page.evaluate(() => {
            const tables = Array.from(document.querySelectorAll('table'));
            // Just get the first table which contains the main IPO list
            if (tables.length === 0) return [];
            
            const rows = Array.from(tables[0].querySelectorAll('tr'));
            
            // First row is headers
            const headers = Array.from(rows[0].querySelectorAll('th, td')).map(h => h.innerText.trim());
            
            const data = [];
            for (let i = 1; i < rows.length; i++) {
                const cells = Array.from(rows[i].querySelectorAll('td')).map(c => c.innerText.trim());
                if (cells.length > 0) {
                    const rowData = {};
                    headers.forEach((header, index) => {
                        rowData[header] = cells[index] || "";
                    });
                    data.push(rowData);
                }
            }
            return data;
        });
        
        console.log(`Extracted ${tablesData.length} IPO records.`);
        
        if (tablesData.length > 0) {
            console.log("Pushing data to Supabase...");
            
            for (const ipo of tablesData) {
                // Use the company name as a unique ID
                const companyName = ipo['COMPANY'] ? ipo['COMPANY'].split('\\n')[0].trim() : 'Unknown';
                const id = companyName.toLowerCase().replace(/[^a-z0-9]/g, '-');
                
                const { error } = await supabase
                    .from('ipos')
                    .upsert({ 
                        id: id, 
                        data: ipo,
                        updated_at: new Date().toISOString()
                    });
                    
                if (error) {
                    console.error(`Error inserting ${companyName}:`, error);
                } else {
                    console.log(`Upserted: ${companyName}`);
                }
            }
            console.log("Successfully updated Supabase!");
        }
        
    } catch (err) {
        console.error("Error scraping IPO site:", err);
    } finally {
        console.log("Closing browser...");
        await browser.close();
    }
}

scrapeIPO();
