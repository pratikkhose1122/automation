require('dotenv').config();
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function run() {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    const page = await browser.newPage();
    await page.goto('https://www.ipopremium.in/view/ipo/1399/tna-solutions-ltd', { waitUntil: 'networkidle2', timeout: 60000 });
    
    const imgs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('img')).map(img => ({
            src: img.src,
            alt: img.alt,
            className: img.className,
            parentClass: img.parentElement ? img.parentElement.className : ''
        }));
    });
    console.log(JSON.stringify(imgs, null, 2));
    await browser.close();
}
run();
