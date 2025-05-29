import fetch from 'node-fetch';

const HORIZON_URL = 'https://api.mainnet.minepi.com';
const sequence = 20934006;

async function getLedger(sequence) {
    const res = await fetch(`${HORIZON_URL}/ledgers/${sequence}`);
    if (!res.ok) {
        throw new Error(`Ledger ${sequence} not found`);
    }
    const ledger = await res.json();

    console.log(`🔹 Ledger ${ledger.sequence}`);
    console.log(`🔹 Closed at: ${ledger.closed_at}`);
    console.log(`🔹 Tx Count: ${ledger.successful_transaction_count}`);
    console.log(`🔹 Hash: ${ledger.hash}`);
    return ledger;
}

getLedger(sequence).catch(console.error);
