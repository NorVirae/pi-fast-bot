// Convert to ESM imports
import StellarSdk from 'stellar-sdk';
import fetch from 'node-fetch';
import bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';

/**
 * Pi Network Transaction Flood Bot
 * 
 * A high-performance bot that monitors Pi Network blocks and floods 
 * the network with claim transactions at precisely the right moment
 * when a claimable balance becomes available.
 * 
 * Enhanced with support for BIP39 seed phrases / passphrases.
 */
class PiNetworkPrecisionClaimBot {
    constructor({
        horizonUrl = 'https://api.mainnet.minepi.com',
        networkPassphrase = StellarSdk.Networks.PUBLIC,
        sourcePassphrase,           // 24-word mnemonic phrase for the wallet with claimable balance
        sponsorPassphrase,          // 24-word mnemonic phrase for the account paying transaction fees (optional)
        sourceSecret,               // Alternative: direct secret key (used if no passphrase provided)
        sponsorSecret,              // Alternative: direct secret key for sponsor (used if no passphrase provided)
        targetAddress,              // Address to sweep funds to
        claimableBalanceId,         // ID of the claimable balance to claim
        unlockTimestamp,            // Unix timestamp when balance becomes claimable
        txCount = 30,               // Number of transactions to flood with
        baseFee = 100000,            // Base fee in stroops
        feeIncrement = 20000,        // Fee increment between transactions
        txSpacingMs = 15,           // Milliseconds between transaction submissions
        derivationPath = "m/44'/314159'/0'"  // BIP44 derivation path for Pi Network
    }) {
        // Initialize SDK
        this.server = new StellarSdk.Server(horizonUrl);

        this.networkPassphrase = networkPassphrase;

        // Store passphrases and keys
        this.sourcePassphrase = sourcePassphrase;
        this.sponsorPassphrase = sponsorPassphrase;
        this.sourceSecret = sourceSecret;
        this.sponsorSecret = sponsorSecret;
        this.derivationPath = derivationPath;

        // We'll initialize the keypairs in initializeKeypairs() before starting the bot
        this.sourceKeypair = null;
        this.sourcePublicKey = null;
        this.sponsorKeypair = null;
        this.sponsorPublicKey = null;

        this.targetAddress = targetAddress;
        this.claimableBalanceId = claimableBalanceId;
        this.unlockTimestamp = unlockTimestamp;

        // Flooding configuration
        this.txCount = txCount;
        this.baseFee = baseFee;
        console.log(`Base fee: ${this.baseFee} stroops`);
        this.feeIncrement = feeIncrement;
        this.txSpacingMs = txSpacingMs;

        // Block monitoring
        this.blockMonitoringActive = false;
        this.blockMonitorInterval = null;
        this.latestLedgerNum = 0;
        this.avgBlockTimeMs = 5000; // Initial estimate, will be refined
        this.blockTimes = [];

        // Bot state
        this.isRunning = false;
        this.transactions = [];
        this.submissionResults = [];
        this.assetType = 'native'; // Default, will be updated when fetching balance details

        console.log(`Initialized Pi Network Precision Claim Bot with passphrase support`);
    }

    /**
     * Initialize keypairs from passphrases or secret keys
     */
    async initializeKeypairs() {
        try {
            // Source account setup (from passphrase or direct secret)
            if (this.sourcePassphrase) {
                console.log('Deriving source keypair from passphrase...');
                this.sourceKeypair = this.keypairFromPassphrase(this.sourcePassphrase);
            } else if (this.sourceSecret) {
                console.log('Using provided source secret key...');
                this.sourceKeypair = StellarSdk.Keypair.fromSecret(this.sourceSecret);
            } else {
                throw new Error('Either sourcePassphrase or sourceSecret must be provided');
            }
            this.baseFee = await this.server.feeStats();
            this.baseFee = this.baseFee["max_fee"]["max"];
            console.log(`Base fee set to: ${JSON.stringify(this.baseFee)} stroops`);
            this.sourcePublicKey = this.sourceKeypair.publicKey();
            console.log(`Source account: ${this.sourcePublicKey}`);

            // Sponsor account setup (optional)
            this.useFeeSponsor = !!(this.sponsorPassphrase || this.sponsorSecret);

            if (this.useFeeSponsor) {
                if (this.sponsorPassphrase) {
                    console.log('Deriving sponsor keypair from passphrase...');
                    this.sponsorKeypair = this.keypairFromPassphrase(this.sponsorPassphrase);
                } else if (this.sponsorSecret) {
                    console.log('Using provided sponsor secret key...');
                    this.sponsorKeypair = StellarSdk.Keypair.fromSecret(this.sponsorSecret);
                }

                this.sponsorPublicKey = this.sponsorKeypair.publicKey();
                console.log(`Fee sponsor account: ${this.sponsorPublicKey}`);
            }

            console.log(`Target sweep address: ${this.targetAddress}`);
            console.log(`Using atomic transactions: claim and transfer in a single operation`);

            return true;
        } catch (error) {
            console.error('Error initializing keypairs:', error.message);
            throw error;
        }
    }

    /**
     * Derive Stellar keypair from a BIP39 mnemonic passphrase
     */
    keypairFromPassphrase(passphrase) {
        if (!passphrase) {
            throw new Error('Passphrase is required');
        }

        try {
            // Validate the mnemonic
            if (!bip39.validateMnemonic(passphrase)) {
                throw new Error('Invalid BIP39 mnemonic passphrase');
            }

            // Convert mnemonic to seed
            const seed = bip39.mnemonicToSeedSync(passphrase);

            // Derive the ED25519 key using the path
            const derivedKey = derivePath(this.derivationPath, seed.toString('hex'));

            // Create Stellar keypair from the derived private key
            return StellarSdk.Keypair.fromRawEd25519Seed(Buffer.from(derivedKey.key));
        } catch (error) {
            console.error('Error deriving keypair from passphrase:', error);
            throw new Error(`Failed to derive keypair: ${error.message}`);
        }
    }

    /**
     * Start monitoring blocks to estimate block time and prepare for claim
     */
    async startBlockMonitoring() {
        if (this.blockMonitoringActive) return;

        console.log('Starting block monitoring...');
        this.blockMonitoringActive = true;

        // Get current ledger info
        const latestLedger = await this.server.ledgers().order('desc').limit(1).call();
        this.latestLedgerNum = latestLedger.records[0].sequence;
        this.lastLedgerCloseTime = new Date(latestLedger.records[0].closed_at).getTime();

        console.log(`Current ledger: ${this.latestLedgerNum}, closed at: ${latestLedger.records[0].closed_at}`);

        // Start monitoring new blocks
        this.blockMonitorInterval = setInterval(async () => {
            try {
                const ledger = await this.server.ledgers().order('desc').limit(1).call();
                const currentLedger = ledger.records[0];
                const currentLedgerNum = currentLedger.sequence;
                const currentCloseTime = new Date(currentLedger.closed_at).getTime();

                // If new block found
                if (currentLedgerNum > this.latestLedgerNum) {
                    const blockTime = currentCloseTime - this.lastLedgerCloseTime;
                    this.blockTimes.push(blockTime);

                    // Keep only last 10 block times for moving average
                    if (this.blockTimes.length > 10) {
                        this.blockTimes.shift();
                    }

                    // Calculate average block time
                    this.avgBlockTimeMs = this.blockTimes.reduce((sum, time) => sum + time, 0) / this.blockTimes.length;

                    console.log(`New block ${currentLedgerNum}, previous block time: ${blockTime}ms, avg: ${Math.round(this.avgBlockTimeMs)}ms`);

                    // Update latest values
                    this.latestLedgerNum = currentLedgerNum;
                    this.lastLedgerCloseTime = currentCloseTime;

                    // Check if we're approaching unlock time
                    this.checkUnlockTimeProximity();
                }
            } catch (error) {
                console.error('Error monitoring blocks:', error.message);
            }
        }, 1000); // Check every second

        return this;
    }

    /**
     * Stop block monitoring
     */
    stopBlockMonitoring() {
        if (this.blockMonitorInterval) {
            clearInterval(this.blockMonitorInterval);
            this.blockMonitorInterval = null;
            this.blockMonitoringActive = false;
            console.log('Block monitoring stopped');
        }
    }

    /**
     * Check if we're approaching the unlock time and prepare for flood if so
     */
    checkUnlockTimeProximity() {
        if (!this.unlockTimestamp) return;

        const now = Date.now();
        const timeToUnlock = this.unlockTimestamp - now;

        // If less than 30 seconds to unlock, prepare transactions
        if (timeToUnlock > 0 && timeToUnlock < 30000 && this.transactions.length === 0) {
            console.log(`Approaching unlock time (${timeToUnlock}ms remaining). Preparing transactions...`);
            this.prepareTransactions();
        }

        // If less than two average block times to unlock, prepare for immediate submission
        if (timeToUnlock > 0 && timeToUnlock < this.avgBlockTimeMs * 2) {
            console.log(`Unlock time approaching within ~2 blocks. Standing by for next block...`);

            // Calculate expected next block time
            const expectedNextBlockTime = this.lastLedgerCloseTime + this.avgBlockTimeMs;

            // If next block is expected to occur after unlock time, prepare to submit at next block
            if (expectedNextBlockTime >= this.unlockTimestamp) {
                console.log(`Next block expected after unlock time. Will submit at next block.`);

                // Set a timer for just before expected next block
                const timeToNextBlock = expectedNextBlockTime - now;
                setTimeout(() => {
                    console.log(`Next block imminent, preparing to flood transactions!`);

                    // Small delay to try to hit beginning of next block processing
                    setTimeout(() => {
                        this.executeFlood();
                    }, 100);
                }, Math.max(0, timeToNextBlock - 500)); // 500ms before expected block
            }
        }

        // If already past unlock time and haven't executed flood yet
        if (timeToUnlock <= 0 && this.isRunning === false) {
            console.log(`Unlock time has passed! Executing flood immediately.`);
            this.executeFlood();
        }
    }

    /**
     * Fetch details about the claimable balance
     */
    async fetchClaimableBalanceDetails() {
        if (!this.claimableBalanceId) {
            throw new Error("Claimable balance ID is required");
        }

        try {
            console.log(`Fetching details for claimable balance: ${this.claimableBalanceId}`);
            const balance = await this.server.claimableBalances()
                .claimableBalance(this.claimableBalanceId)
                .call();

            // Parse asset information
            if (balance.asset === 'native') {
                this.assetType = 'native';
                this.assetCode = 'XLM';
            } else {
                const [code, issuer] = balance.asset.split(':');
                this.assetType = 'custom';
                this.assetCode = code;
                this.assetIssuer = issuer;
            }

            console.log(`Claimable balance details: ${balance.amount} ${this.assetCode}`);
            console.log(`Claimants: ${balance.claimants.length}`);

            // Check for time predicates
            for (const claimant of balance.claimants) {
                if (claimant.destination === this.sourcePublicKey) {
                    console.log(`Found matching claimant predicate for our account`);

                    // Parse time predicate if exists
                    if (claimant.predicate && claimant.predicate.not && claimant.predicate.not.abs_before) {
                        const unlockTimeISO = claimant.predicate.not.abs_before;
                        const unlockTimeMs = new Date(unlockTimeISO).getTime();

                        // If not explicitly set, use the one from the predicate
                        if (!this.unlockTimestamp) {
                            this.unlockTimestamp = unlockTimeMs;
                            console.log(`Using unlock time from predicate: ${unlockTimeISO}`);
                        }

                        const now = Date.now();
                        const timeToUnlock = this.unlockTimestamp - now;

                        if (timeToUnlock > 0) {
                            console.log(`Time until unlock: ${Math.round(timeToUnlock / 1000)} seconds`);
                        } else {
                            console.log(`Claimable balance is already unlocked!`);
                        }
                    }
                }
            }

            return balance;
        } catch (error) {
            console.error('Error fetching claimable balance details:', error.message);
            throw error;
        }
    }

    /**
     * Prepare transactions for flooding in advance
     * Creates atomic transactions that both claim the balance AND transfer to target in one operation
     */
    async prepareTransactions() {
        try {
            console.log(`Preparing ${this.txCount} atomic claim+transfer transactions with varying fees`);

            // Load source account
            const sourceAccount = await this.server.loadAccount(this.sourcePublicKey);
            console.log(`Source account loaded. Sequence number: ${sourceAccount.sequenceNumber()}`);

            if (this.useFeeSponsor) {
                // Also load sponsor account if using fee sponsorship
                const sponsorAccount = await this.server.loadAccount(this.sponsorPublicKey);
                console.log(`Sponsor account loaded. Sequence number: ${sponsorAccount.sequenceNumber()}`);
            }

            // Fetch claimable balance details to get asset information if not done already
            if (!this.assetType) {
                await this.fetchClaimableBalanceDetails();
            }

            // Determine asset for the transfer operation
            let asset = StellarSdk.Asset.native();
            if (this.assetType === 'custom' && this.assetCode && this.assetIssuer) {
                asset = new StellarSdk.Asset(this.assetCode, this.assetIssuer);
            }

            // Build all transactions
            this.transactions = [];

            for (let i = 0; i < this.txCount; i++) {
                // Calculate fee - incrementing for each tx
                const fee = this.baseFee + (i * this.feeIncrement);

                // Create a new account object with an incremented sequence number
                // FIXED: Directly increment sequence number using BigInt
                const currentSequence = BigInt(sourceAccount.sequenceNumber());
                const newSequence = (currentSequence + BigInt(1)).toString();

                // Create a new account with the incremented sequence number
                const txAccount = new StellarSdk.Account(this.sourcePublicKey, newSequence);

                // Build transaction with BOTH claim AND transfer operations atomically
                const txBuilder = new StellarSdk.TransactionBuilder(txAccount, {
                    fee: fee.toString(),
                    networkPassphrase: this.networkPassphrase
                })
                    // First operation: Claim the claimable balance
                    .addOperation(StellarSdk.Operation.claimClaimableBalance({
                        balanceId: this.claimableBalanceId
                    }));

                // Second operation: Transfer the claimed amount to target address
                // We use pathPaymentStrictSend to ensure we send everything we just claimed
                txBuilder.addOperation(StellarSdk.Operation.pathPaymentStrictSend({
                    sendAsset: asset,
                    sendAmount: "99999999", // This is a placeholder, actual amount limited by balance
                    destination: this.targetAddress,
                    destAsset: asset,
                    destMin: "0.0000001" // Ensure transaction succeeds even with small amounts
                }));

                // Set reasonable timeout
                const tx = txBuilder.setTimeout(300).build();

                // Sign with source account
                tx.sign(this.sourceKeypair);

                // Apply fee sponsorship if enabled
                let finalTx = tx;
                if (this.useFeeSponsor) {
                    const feeBumpTx = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
                        this.sponsorKeypair,
                        fee.toString(),
                        tx,
                        this.networkPassphrase
                    );

                    // Sign with sponsor account
                    feeBumpTx.sign(this.sponsorKeypair);
                    finalTx = feeBumpTx;
                }

                this.transactions.push({
                    tx: finalTx,
                    fee: fee,
                    index: i,
                    xdr: finalTx.toXDR()
                });
            }

            // Sort by fee descending to submit highest fee transactions first
            this.transactions.sort((a, b) => b.fee - a.fee);

            console.log(`Prepared ${this.transactions.length} atomic transactions with fees ranging from ${this.transactions[this.transactions.length - 1].fee} to ${this.transactions[0].fee} stroops`);
        } catch (error) {
            console.error('Error preparing transactions:', error.message);
            throw error;
        }
    }

    /**
     * Execute the transaction flood
     */
    async executeFlood() {
        if (this.isRunning) return;
        this.isRunning = true;

        console.log(`🚀 EXECUTING TRANSACTION FLOOD 🚀`);

        try {
            // If transactions aren't prepared yet, do it now
            if (this.transactions.length === 0) {
                await this.prepareTransactions();
            }

            // Submit all transactions with minimal delay between them
            this.submissionResults = [];
            const submissionPromises = [];

            for (let i = 0; i < this.transactions.length; i++) {
                const txInfo = this.transactions[i];

                // Stagger submissions slightly for network efficiency
                const submissionPromise = new Promise(resolve => {
                    setTimeout(async () => {
                        try {
                            console.log(`Submitting tx ${i + 1}/${this.transactions.length} with fee: ${txInfo.fee} stroops`);
                            const result = await this.server.submitTransaction(txInfo.tx);

                            console.log(`✅ Transaction ${i + 1} successful! Hash: ${result.hash}`);
                            this.submissionResults.push({
                                success: true,
                                index: txInfo.index,
                                fee: txInfo.fee,
                                hash: result.hash
                            });

                            resolve(result);
                        } catch (error) {
                            console.log(`❌ Transaction ${i + 1} failed: ${error}`);
                            this.submissionResults.push({
                                success: false,
                                index: txInfo.index,
                                fee: txInfo.fee,
                                error: error.message
                            });
                            resolve(null);
                        }
                    }, i * this.txSpacingMs);
                });

                submissionPromises.push(submissionPromise);
            }

            // Wait for all submissions to complete
            await Promise.all(submissionPromises);

            const successCount = this.submissionResults.filter(r => r.success).length;
            console.log(`Flood complete. ${successCount}/${this.transactions.length} transactions succeeded.`);

            // Since each transaction both claims and transfers, we don't need a separate sweep
            if (successCount > 0) {
                console.log(`At least one atomic claim+transfer was successful! Balance should be in target account: ${this.targetAddress}`);
            } else {
                console.log(`All transactions failed. Asset may have been claimed by another party.`);
            }

        } catch (error) {
            console.error('Error executing transaction flood:', error.message);
        } finally {
            // Stop block monitoring, no longer needed
            this.stopBlockMonitoring();
        }
    }

    /**
     * Execute sweep transaction to move claimed funds to target address
     */
    async executeSweep() {
        try {
            console.log(`Executing sweep to target address: ${this.targetAddress}`);

            // Load source account with fresh data
            const sourceAccount = await this.server.loadAccount(this.sourcePublicKey);

            // Find the balance of the asset we just claimed
            let assetBalance = "0";
            let asset = StellarSdk.Asset.native(); // Default to XLM

            if (this.assetType === 'native') {
                // For XLM, we need to account for reserve and fees
                const xlmBalance = sourceAccount.balances.find(b => b.asset_type === 'native');
                if (xlmBalance) {
                    // Leave 1.5 XLM for reserve and fees
                    const reserve = 1.5;
                    const available = parseFloat(xlmBalance.balance) - reserve;
                    assetBalance = available > 0 ? available.toFixed(7) : "0";
                }
            } else {
                // For other assets, find the matching balance
                const customBalance = sourceAccount.balances.find(b =>
                    b.asset_code === this.assetCode &&
                    b.asset_issuer === this.assetIssuer
                );

                if (customBalance) {
                    assetBalance = customBalance.balance;
                    asset = new StellarSdk.Asset(this.assetCode, this.assetIssuer);
                }
            }

            if (parseFloat(assetBalance) <= 0) {
                console.log(`No balance to sweep. Asset balance: ${assetBalance} ${this.assetCode}`);
                return;
            }

            console.log(`Sweeping ${assetBalance} ${this.assetCode} to ${this.targetAddress}`);

            // Calculate a high fee for the sweep to ensure it goes through quickly
            const sweepFee = this.baseFee * 2;

            // Build sweep transaction
            const sweepTx = new StellarSdk.TransactionBuilder(sourceAccount, {
                fee: sweepFee.toString(),
                networkPassphrase: this.networkPassphrase
            })
                .addOperation(StellarSdk.Operation.payment({
                    destination: this.targetAddress,
                    asset: asset,
                    amount: assetBalance
                }))
                .setTimeout(60)
                .build();

            // Sign with source account
            sweepTx.sign(this.sourceKeypair);

            // Apply fee sponsorship if enabled
            let finalSweepTx = sweepTx;
            if (this.useFeeSponsor) {
                const feeBumpTx = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
                    this.sponsorKeypair,
                    sweepFee.toString(),
                    sweepTx,
                    this.networkPassphrase
                );

                // Sign with sponsor account
                feeBumpTx.sign(this.sponsorKeypair);
                finalSweepTx = feeBumpTx;
            }

            // Submit sweep transaction
            const sweepResult = await this.server.submitTransaction(finalSweepTx);
            console.log(`✅ Sweep transaction successful! Hash: ${sweepResult.hash}`);
            console.log(`Funds successfully transferred to ${this.targetAddress}`);

            return {
                success: true,
                amount: assetBalance,
                asset: this.assetCode,
                hash: sweepResult.hash
            };

        } catch (error) {
            console.error('Error executing sweep:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Initialize the bot and start monitoring
     */
    async start() {
        console.log(`Starting Pi Network Precision Claim Bot`);

        // Initialize keypairs from passphrases or secrets first
        await this.initializeKeypairs();

        // Fetch claimable balance details
        await this.fetchClaimableBalanceDetails();

        // Start block monitoring
        await this.startBlockMonitoring();

        // Check if we already need to execute
        const now = Date.now();
        if (this.unlockTimestamp && now >= this.unlockTimestamp) {
            console.log(`Unlock time has already passed. Executing flood immediately.`);
            await this.executeFlood();
        } else if (this.unlockTimestamp) {
            const timeToUnlock = this.unlockTimestamp - now;
            console.log(`Waiting for unlock time. ${Math.round(timeToUnlock / 1000)} seconds remaining.`);

            // If more than 30 seconds away, set a timer to prepare transactions later
            if (timeToUnlock > 30000) {
                setTimeout(() => {
                    this.prepareTransactions();
                }, timeToUnlock - 30000); // Prepare 30 seconds before unlock
            } else {
                // Prepare transactions now if less than 30 seconds away
                this.prepareTransactions();
            }
        } else {
            console.log(`No unlock time specified. Please trigger claim manually.`);
        }

        return this;
    }

    /**
     * Trigger claim manually (for use when automatic timing is not available)
     */
    async triggerClaimNow() {
        console.log(`Manually triggering claim process`);
        await this.executeFlood();
        return this;
    }

    /**
     * Stop the bot and clean up
     */
    stop() {
        this.stopBlockMonitoring();
        this.isRunning = false;
        console.log(`Bot stopped`);
        return this;
    }
}

/**
 * Usage example
 */
async function main() {
    // Configuration
    const config = {
        // Network configuration
        horizonUrl: 'https://api.mainnet.minepi.com',
        networkPassphrase: "Pi Network",

        // Account configuration - use either passphrase OR secret key
        sourcePassphrase: 'rookie final now mean banana ocean follow leave make scan season roast reason damp guitar glory arrest lyrics eager maximum alert satisfy merge one',  // 24-word mnemonic
        // sourceSecret: 'YOUR_SOURCE_SECRET_KEY',  // Alternative: direct secret key

        // Sponsor account - use either passphrase OR secret key (optional)
        sponsorPassphrase: 'coach sun mesh avocado twenty dance august wrap lumber cupboard retire faith canal few alone seek notice hawk multiply theory proof tell cable sure',  // 24-word mnemonic
        // sponsorSecret: 'YOUR_SPONSOR_SECRET_KEY', // Alternative: direct secret key

        targetAddress: 'GD7S6BLJ6IERF3VENCNZBRQREXPG4NLUCFVWOLYE5RJ5DDPPWAUHFUMB',

        // Claimable balance configuration
        claimableBalanceId: '000000000eeaef6ad371924f0230f9943186eefbc8358b5806d51f0eaa9ebd2093d3462a',
        unlockTimestamp: 1746410900000, // Unix timestamp in milliseconds when balance unlocks

        // Flooding configuration
        txCount: 40,           // Send 40 transactions
        baseFee: 10000,        // Start at 10,000 stroops (0.001 XLM)
        feeIncrement: 5000,    // Increment by 5,000 stroops per tx
        txSpacingMs: 15,       // Space submissions 15ms apart

        // Optional: Custom derivation path (default is for Pi Network)
        derivationPath: "m/44'/314159'/0'"  // BIP44 derivation path for Pi Network
    };

    console.log(config)

    const bot = new PiNetworkPrecisionClaimBot(config);

    // Start monitoring and automatic execution
    await bot.start();

    // Or trigger manually without waiting for timestamp
    // await bot.triggerClaimNow();
}

// Only run if executed directly
// if (import.meta.url === import.meta.main) {
main().catch(error => {
    console.error('Bot execution error:', error);
    process.exit(1);
});
// }

export default PiNetworkPrecisionClaimBot;