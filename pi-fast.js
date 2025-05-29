// Pi Network Sweeper Bot: Claim All & Continuous Flood (Optimized & Aggressive)
// – Uses p99‐based fee bidding up to 50 PI
// – Pre‐builds & pre‐signs transactions with customizable timebounds
// – Submits early (configurable offset in seconds) before unlock to beat latency
// – Refreshes sponsor account sequence for each TX
// – Employs Stellar Fee Bump for in‐flight retries

import * as ed25519 from 'ed25519-hd-key';
import StellarSdk from 'stellar-sdk';
import * as bip39 from 'bip39';

// Configuration
const config = {
    horizonUrl: 'https://api.mainnet.minepi.com',
    networkPassphrase: 'Pi Network',
    baseFee: 100000,                // 0.01 PI (stroops)
    maxFee: 500000,             // 0.05 PI ceiling for bidding
    feePriorityMultiplier: 10,     // multiplier on p99
    maxSubmissionAttempts: 3,
    floodCount: 3,
    floodInterval: 200,
    debug: true,
    timeboundGrace: 60,             // seconds after unlock
    earlySubmitOffset: 1,           // seconds before unlock (submit early)
    pollIntervalMs: 10,             // tighter polling
};

class PiSweeperBot {
    constructor(targetMnemonic, destination, sponsorMnemonic) {
        this.dest = destination;
        this.targetKP = this.mnemonicToKeypair(targetMnemonic);
        this.sponsorKP = this.mnemonicToKeypair(sponsorMnemonic);
        this.server = new StellarSdk.Server(config.horizonUrl, { allowHttp: false });
        this.log(`Initialized. Target: ${this.targetKP.publicKey()}  Sponsor: ${this.sponsorKP.publicKey()} Account to Trans: ${this.dest}`);
    }

    log(msg) {
        if (config.debug) console.log(`[${new Date().toISOString()}] ${msg}`);
    }

    mnemonicToKeypair(mnemonic) {
        const seed = bip39.mnemonicToSeedSync(mnemonic);
        const path = "m/44'/314159'/0'";
        const { key } = ed25519.derivePath(path, seed.toString('hex'));
        return StellarSdk.Keypair.fromRawEd25519Seed(Buffer.from(key));
    }

    async getAllBalances() {
        const resp = await this.server
            .claimableBalances()
            .claimant(this.targetKP.publicKey())
            .limit(200)
            .call();
        return resp.records;
    }

    extractMinTime(balance) {
        // 'not.abs_before' means claimable after this time
        const claimant = balance.claimants.find(c => c.destination === this.targetKP.publicKey());
        if (claimant && claimant.predicate) {
            if (claimant.predicate.abs_after) {
                console.log(claimant.predicate.abs_after, " CHEKC")
                return parseInt(claimant.predicate.abs_after, 10);
            }
            if (claimant.predicate.not && claimant.predicate.not.abs_before_epoch) {
                console.log(claimant.predicate.not.abs_before_epoch, " CHEKC TIME")

                return parseInt(claimant.predicate.not.abs_before_epoch, 10);
            }
        }
        return 0;
    }

    async updateFeeStats() {
        const stats = await this.server.feeStats();
        const p99 = parseInt(stats.fee_charged.p99, 10);

        const fee = p99 * config.feePriorityMultiplier;
        this.currentFee = fee * 7;
        this.log(`Fee updated (p99): ${this.currentFee} stroops, fee: ${fee}, p99: ${p99}`);
    }

    /**
     * Builds and signs a transaction with a lower timebound set
     * to (unlockTime - earlySubmitOffset) and upper bound unlockTime + grace.
     */
    async buildAndSign(balance, sponsorAccount) {
        const { id, amount } = balance;
        const unlockTime = this.extractMinTime(balance);
        const lowerBound = unlockTime;
        const upperBound = unlockTime + config.timeboundGrace;

        let newLowerBound = Date.now()
        newLowerBound = (newLowerBound / 1000) - 1

        console.log(newLowerBound, "New Lower Bound", Date.now())

        const builder = new StellarSdk.TransactionBuilder(
            sponsorAccount,
            {
                fee: String(this.currentFee),
                networkPassphrase: config.networkPassphrase,
            })
            .addOperation(StellarSdk.Operation.claimClaimableBalance({
                balanceId: id,
                source: this.targetKP.publicKey(),
            }))
            .addOperation(StellarSdk.Operation.payment({
                destination: this.dest,
                asset: StellarSdk.Asset.native(),
                amount: amount,
                source: this.targetKP.publicKey(),
            }))
            .setTimebounds(lowerBound, upperBound);

        const tx = builder.build();
        // ✅ Sign with both parties: claimer (targetKP) AND fee sponsor (sponsorKP)
        tx.sign(this.targetKP);
        tx.sign(this.sponsorKP);

        return tx;
    }

    async submitWithRetries(tx) {
        try {
            const result = await this.server.submitTransaction(tx);
            this.log(`Submitted pre-signed TX successfully ` + JSON.stringify(result));
            return;
        } catch (err) {
            this.log(`Initial submit failed: ${err}`);
        }

        for (let attempt = 1; attempt <= config.maxSubmissionAttempts; attempt++) {
            this.currentFee = this.currentFee * config.feePriorityMultiplier;
            console.log(this.currentFee, "CUURE FEE")
            const feeBump = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
                this.sponsorKP,
                String(this.currentFee),
                tx,
                config.networkPassphrase
            );
            feeBump.sign(this.sponsorKP);
            try {
                await this.server.submitTransaction(feeBump);
                this.log(`Fee-bump #${attempt} success at ${this.currentFee}`);
                return;
            } catch (e) {
                this.log(`Fee-bump #${attempt} failed: ${e}`);
            }
        }
        this.log(`All retries exhausted.`);
    }


    async getLatestLedger() {
        console.log(config.horizonUrl, "HOSRISKA")
        const res = await fetch(`${config.horizonUrl}/ledgers?order=desc&limit=1`);
        const data = await res.json();

        if (data._embedded && data._embedded.records.length > 0) {
            const ledger = data._embedded.records[0];
            const sequence = parseInt(ledger.sequence, 10);
            const closeTime = new Date(ledger.closed_at); // ISO format

            return { sequence, closeTime };
        }

        throw new Error('Failed to fetch ledger');
    }

    async start() {
        this.log(`Starting main loop...`);
        while (true) {
            try {
                await this.updateFeeStats();
                const balances = await this.getAllBalances();
                if (!balances.length) {
                    this.log('No claimable balances. Sleeping 5s...');
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }

                for (const bal of balances) {
                    const unlockTime = this.extractMinTime(bal);
                    if (unlockTime === 0) {
                        this.log(`Skipping ${bal.id} — not yet claimable`);
                        continue;
                    }

                    // Wait until we hit the lower timebound (unlockTime - offset)
                    const submitTime = unlockTime - config.earlySubmitOffset;
                    const now = Date.now() / 1000;
                    const wait = Math.max(submitTime - now, 0);
                    this.log(`Waiting ${wait.toFixed(3)}s before early submit for ${bal.id}`);
                    await new Promise(r => setTimeout(r, wait * 1000));

                    let sp = this.sponsorKP.publicKey()
                    const sponsorResp = await this.server.loadAccount(this.sponsorKP.publicKey());
                    console.log(sp)
                    const sponsorAccount = new StellarSdk.Account(sponsorResp.account_id, sponsorResp.sequence);
                    const tx = await this.buildAndSign(bal, sponsorAccount);
                    let ledge = await this.getLatestLedger()
                    console.log("Last Block closed at & Current block starts at: ", JSON.stringify(ledge))

                    await this.submitWithRetries(tx);

                    await new Promise(r => setTimeout(r, config.pollIntervalMs));
                }
            } catch (e) {
                this.log(`Loop error: ${e}`);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    }
}

(async () => {
    const target = 'rigid juice rare property dust athlete ice mosquito focus cancel cycle open slight health cloth false media grass blind plate silent effort mad useless';
    const sponsor = '';
    const dest = 'GAHQMFHVA7EKDD54L4HBX4QNCTGCLVTCP5DXKKFSTEBTQBNG6WDVGLCR';

    const bot = new PiSweeperBot(target, dest, sponsor);
    await bot.start();
})();
