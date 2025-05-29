import fetch from 'node-fetch';

const HORIZON_URL = 'https://api.mainnet.minepi.com';
const LEDGER_INTERVAL = 5; // Pi Network closes a ledger ~every 5 seconds

let lastLedger = 0;

async function getLatestLedger() {
    const res = await fetch(`${HORIZON_URL}/ledgers?order=desc&limit=1`);
    const data = await res.json();

    if (data._embedded && data._embedded.records.length > 0) {
        const ledger = data._embedded.records[0];
        const sequence = parseInt(ledger.sequence, 10);
        const closeTime = new Date(ledger.closed_at); // ISO format

        return { sequence, closeTime };
    }

    throw new Error('Failed to fetch ledger');
}

async function monitorBlocks() {
    while (true) {
        try {
            const ledger = await getLatestLedger();
            // console.log(ledger)


            if (ledger.sequence !== lastLedger) {
                lastLedger = ledger.sequence;
                const nextClose = new Date(ledger.closeTime.getTime() + LEDGER_INTERVAL * 1000);

                console.log(`🧱 Ledger ${ledger.sequence} closed at ${ledger.closeTime.toISOString()}`);
                // console.log(`⏱️ Estimated next ledger close at: ${nextClose.toISOString()}`);
            }

            await new Promise(r => setTimeout(r, 1000)); // poll every second
        } catch (e) {
            console.error('Error:', e.message);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

monitorBlocks();
