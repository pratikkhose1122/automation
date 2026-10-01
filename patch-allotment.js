require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function fixAllotmentLinks() {
    const { data: allIpos, error } = await supabase.from('ipos').select('id, data');
    const ipos = allIpos.filter(i => i.data?.meta?.published === true || String(i.data?.meta?.published) === 'true');
    if (error) {
        console.error(error);
        return;
    }
    
    console.log(`Found ${ipos.length} published IPOs in DB.`);
    
    const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox']});
    const page = await browser.newPage();
    
    // Get all IPO names and action URLs from the main table
    await page.goto('https://www.ipopremium.in/', { waitUntil: 'networkidle2', timeout: 60000 });
    const scrapedIpos = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tr'));
        if (rows.length === 0) return [];
        const headers = Array.from(rows[0].querySelectorAll('th, td')).map(h => h.innerText.trim().toUpperCase());
        const actionIdx = headers.indexOf('ACTION');
        const companyIdx = headers.indexOf('COMPANY');
        
        return rows.slice(1).map(row => {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length === 0) return null;
            
            const companyCell = cells[companyIdx];
            const companyName = companyCell ? companyCell.innerText.trim().split('\n')[0] : '';
            
            const actionCell = cells[actionIdx];
            let actionUrl = '';
            if (actionCell) {
                const actionLink = actionCell.querySelector('a, button');
                if (actionLink && actionLink.href) {
                    actionUrl = actionLink.href;
                } else if (actionLink && actionLink.getAttribute('onclick')) {
                    const match = actionLink.getAttribute('onclick').match(/window\.open\(['"](.*?)['"]/);
                    if (match) actionUrl = match[1];
                }
            }
            
            return { companyName, actionUrl };
        }).filter(r => r && r.companyName && r.actionUrl && !r.actionUrl.includes('/bids/create'));
    });
    
    console.log(`Scraped ${scrapedIpos.length} IPOs with allotment URLs from ipopremium.in.`);
    
    for (const scraped of scrapedIpos) {
        let cleanName = scraped.companyName.toLowerCase();
        cleanName = cleanName.split(' ipo gmp')[0];
        cleanName = cleanName.split(' (')[0];
        cleanName = cleanName.replace(/ ltd\.?| limited/g, '').trim();

        const match = ipos.find(i => {
            const dbBasicName = (i.data.basic?.name || '').toLowerCase().replace(/ ltd\.?| limited/g, '').trim();
            const dbCompany = (i.data['COMPANY'] || '').toLowerCase().replace(/ ltd\.?| limited/g, '').trim();
            return (dbBasicName && dbBasicName.includes(cleanName)) || 
                   (dbCompany && dbCompany.includes(cleanName)) ||
                   (cleanName && dbBasicName && cleanName.includes(dbBasicName));
        });
        
        if (match) {
            console.log(`Found DB match for ${scraped.companyName}: ID ${match.id} -> patching ${scraped.actionUrl}`);
            
            const updatedData = { ...match.data };
            if (!updatedData.details) updatedData.details = {};
            if (!updatedData.details.registrarDetails) updatedData.details.registrarDetails = {};
            
            // Only update if not already set, or overwrite? We'll overwrite because the scraped one is fresh.
            updatedData.details.registrarDetails.allotmentLink = scraped.actionUrl;
            
            const {error: updateError} = await supabase.from('ipos').update({ data: updatedData }).eq('id', match.id);
            if (updateError) {
                console.error(`Failed to update allotment URL for ${scraped.companyName}:`, updateError);
            } else {
                console.log(`Successfully updated allotment URL for ${scraped.companyName}`);
            }
        }
    }
    
    await browser.close();
    console.log("Done fixing allotment links!");
}

fixAllotmentLinks();
