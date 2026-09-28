const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function scrapeIPO() {
    console.log("Starting headless browser...");
    // Launch headless Chromium (automatically downloaded by puppeteer)
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Recommended for cloud environments
    });
    
    try {
        const page = await browser.newPage();
        
        console.log("Navigating to https://www.ipopremium.in/ ...");
        await page.goto('https://www.ipopremium.in/', { waitUntil: 'networkidle2', timeout: 60000 });
        
        console.log("Extracting table data...");
        const tablesData = await page.evaluate(() => {
            const tables = Array.from(document.querySelectorAll('table'));
            return tables.map((table, index) => {
                const rows = Array.from(table.querySelectorAll('tr'));
                return {
                    tableIndex: index,
                    rows: rows.map(row => {
                        const cells = Array.from(row.querySelectorAll('th, td'));
                        return cells.map(cell => cell.innerText.trim());
                    })
                };
            });
        });
        
        // In a real cloud setup, you would push this data to Firebase/MongoDB here.
        // For now, we save it locally to verify it works.
        const outputPath = path.join(__dirname, 'ipo_data.json');
        fs.writeFileSync(outputPath, JSON.stringify(tablesData, null, 2));
        console.log(`Successfully extracted ${tablesData.length} tables to ipo_data.json`);
        
    } catch (err) {
        console.error("Error scraping IPO site:", err);
    } finally {
        console.log("Closing browser...");
        await browser.close();
    }
}

scrapeIPO();
