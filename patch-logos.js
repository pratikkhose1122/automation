require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

async function fixLogos() {
    const { data: ipos, error } = await supabase.from('ipos').select('id, data');
    if (error) {
        console.error(error);
        return;
    }
    
    console.log(`Found ${ipos.length} IPOs in DB.`);
    
    const browser = await puppeteer.launch({headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox']});
    const page = await browser.newPage();
    
    // Get all links from ipopremium
    await page.goto('https://www.ipopremium.in/', { waitUntil: 'networkidle2', timeout: 60000 });
    const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('table tr a')).map(a => a.href);
    });
    
    for (const link of links) {
        console.log(`Checking ${link}`);
        await page.goto(link, { waitUntil: 'networkidle2', timeout: 60000 });
        const details = await page.evaluate(() => {
            const companyName = document.querySelector('h1')?.innerText?.trim() || '';
            
            function getAbsoluteUrl(urlStr) {
                if (!urlStr) return null;
                let trimmed = urlStr.trim();
                if (!trimmed) return null;
                if (trimmed.startsWith('data:image')) return trimmed;
                if (trimmed.match(/placeholder/i)) return null;
                try {
                    return new URL(trimmed, window.location.origin).href;
                } catch (e) {
                    return null;
                }
            }

            let logoUrl = null;
            const potentialImgs = Array.from(document.querySelectorAll('img'));
            
            for (const img of potentialImgs) {
                const src = img.src || '';
                const dataSrc = img.getAttribute('data-src') || '';
                const dataLazySrc = img.getAttribute('data-lazy-src') || '';
                const dataOriginal = img.getAttribute('data-original') || '';
                const srcset = img.srcset || img.getAttribute('data-srcset') || '';
                const alt = (img.alt || '').toLowerCase();
                
                let candidate = dataSrc || dataLazySrc || dataOriginal;
                if (!candidate && srcset) {
                    candidate = srcset.split(',')[0].trim().split(' ')[0];
                }
                if (!candidate) {
                    candidate = src;
                }
                
                candidate = getAbsoluteUrl(candidate);
                if (!candidate) continue;

                const lowerCandidate = candidate.toLowerCase();
                if (lowerCandidate.includes('ipopremium') && lowerCandidate.includes('logo')) continue;
                if (lowerCandidate.includes('/img/ads/')) continue;
                if (lowerCandidate.includes('logo-light') || lowerCandidate.includes('logo-dark')) continue;
                
                if (img.closest('.ip-logo') || lowerCandidate.includes('/images/ipo/')) {
                    logoUrl = candidate;
                    break;
                }
                
                if (alt.includes('logo') && !logoUrl) {
                    logoUrl = candidate;
                }
            }
            
            return { companyName, logoUrl };
        });
        
        if (details.companyName && details.logoUrl) {
            // Fix H1 parsing: The H1 usually looks like "Company Name IPO GMP, Date..." or "Company Name (India) IPO GMP..."
            let cleanName = details.companyName.toLowerCase();
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
                console.log(`Found match in DB for ${details.companyName}: ID ${match.id}`);
                
                // Update basic.logoUrl if it exists, or logo_url if it's raw
                const updatedData = { ...match.data };
                if (updatedData.basic) {
                    updatedData.basic.logoUrl = details.logoUrl;
                }
                if (updatedData.detailed_info) {
                    updatedData.detailed_info.logo_url = details.logoUrl;
                }
                if (!updatedData.basic && !updatedData.detailed_info) {
                    updatedData.logo_url = details.logoUrl;
                }
                
                const {error: updateError} = await supabase.from('ipos').update({ data: updatedData }).eq('id', match.id);
                if (updateError) {
                    console.error(`Failed to update logo for ${details.companyName}:`, updateError);
                } else {
                    console.log(`Updated logo for ${details.companyName} -> ${details.logoUrl}`);
                }
            }
        }
    }
    
    await browser.close();
    console.log("Done fixing logos!");
}

fixLogos();
