// Quick audit: check SSL certificates and connectivity for all registrar endpoints
const https = require('https');
const tls = require('tls');

function checkSSL(hostname, path = '/') {
    return new Promise((resolve) => {
        const socket = tls.connect(443, hostname, { servername: hostname }, () => {
            const cert = socket.getPeerCertificate();
            socket.end();
            resolve({
                hostname,
                valid: socket.authorized,
                subject: cert.subject?.CN,
                issuer: cert.issuer?.O,
                validFrom: cert.valid_from,
                validTo: cert.valid_to,
                protocol: socket.getProtocol(),
            });
        });
        socket.on('error', (err) => {
            resolve({
                hostname,
                valid: false,
                error: err.message,
            });
        });
        socket.setTimeout(10000, () => {
            socket.destroy();
            resolve({ hostname, valid: false, error: 'Timeout' });
        });
    });
}

async function main() {
    const endpoints = [
        { name: 'KFintech AWS API', host: '0uz601ms56.execute-api.ap-south-1.amazonaws.com' },
        { name: 'KFintech Status', host: 'ipostatus.kfintech.com' },
        { name: 'LinkIntime/MUFG', host: 'in.mpms.mufg.com' },
        { name: 'BigShare IPO Status', host: 'ipo.bigshareonline.com' },
        { name: 'BigShare Allotment', host: 'www.bigshareonline.com' },
    ];

    for (const ep of endpoints) {
        const result = await checkSSL(ep.host);
        console.log(`\n=== ${ep.name} (${ep.host}) ===`);
        if (result.error) {
            console.log(`  ❌ SSL ERROR: ${result.error}`);
        } else {
            console.log(`  ✅ Valid: ${result.valid}`);
            console.log(`  Subject: ${result.subject}`);
            console.log(`  Issuer: ${result.issuer}`);
            console.log(`  Protocol: ${result.protocol}`);
            console.log(`  Valid: ${result.validFrom} → ${result.validTo}`);
        }
    }
}

main();
