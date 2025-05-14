// Pi Network High-Performance Sweeper Bot
// This bot is designed to be extremely fast in claiming and transferring balances
// using advanced bundling techniques and optimized network operations
import * as ed25519 from 'ed25519-hd-key';
import StellarSdk from 'stellar-sdk';
import * as bip39 from 'bip39';
import axios from 'axios';
import WebSocket from 'ws';

// Configuration
const config = {
    // Pi Network horizons - We'll use multiple endpoints for redundancy and speed
    horizonUrls: [
        'https://api.mainnet.minepi.com',
    ],
    // Default fee - will be dynamically adjusted based on network conditions
    baseFee: 100000, // 0.01 PI
    // Number of operations to include in each transaction batch
    batchSize: 3,
    // Maximum number of parallel connections
    maxConnections: 5,
    // Connection timeout in milliseconds
    connectionTimeout: 5000,
    // How often to check for unlock times (in milliseconds)
    pollInterval: 10,
    // Buffer time before unlock (in milliseconds) to start preparing
    prepareBuffer: 10000,
    // Network passphrase for Pi Network
    networkPassphrase: "Pi Network",
    // WebSocket endpoint for real-time block notifications
    // Updated to a correct endpoint or disabled with fallback to polling
    blockStreamWs: null, // 'wss://ws.pinetwork.com/blocks' - Setting to null to disable WebSocket
    // Gas fee multiplier to outbid competitors
    feePriorityMultiplier: 1.5,
    // Maximum fee willing to pay (safety limit)
    maxFee: 1000000, // 0.1 PI
    // Number of submission attempts
    maxSubmissionAttempts: 3,
    // Enable debug logging
    debug: true,
    // Enable WebSocket (set to false to disable WebSocket and use polling only)
    enableWebSocket: false
};

class PiSweeperBot {
    constructor(targetMnemonic, destinationAddress, sponsorMnemonic) {
        this.targetMnemonic = targetMnemonic;
        this.destinationAddress = destinationAddress;
        this.sponsorMnemonic = sponsorMnemonic;

        // Initialize SDK clients (one for each horizon)
        this.stellarClients = config.horizonUrls.map(url => new StellarSdk.Server(url, {
            allowHttp: false,
            timeout: config.connectionTimeout
        }));

        // Convert mnemonics to keypairs
        this.targetKeypair = this.mnemonicToKeypair(targetMnemonic);
        this.sponsorKeypair = this.mnemonicToKeypair(sponsorMnemonic);

        // Cache for account data
        this.accountCache = {
            target: null,
            sponsor: null,
            lastUpdated: 0
        };

        // Track best network conditions
        this.networkStats = {
            bestHorizon: 0,
            currentFee: config.baseFee * 3,
            lastLedger: 0,
            ledgerCloseTime: 0
        };

        // Track unlock data for the target account
        this.unlockData = {
            unlockTime: null,
            unlockBlock: null,
            claimableBalance: null,
            claimableBalanceId: null
        };

        // WebSocket connection for real-time updates
        this.ws = null;

        // Polling interval ID
        this.pollingIntervalId = null;

        // Transaction submission status
        this.submissionStatus = {
            preparing: false,
            submitted: false,
            confirmed: false,
            attempts: 0
        };

        this.log('Sweeper bot initialized');
        this.log(`Target account: ${this.targetKeypair.publicKey()}`);
        this.log(`Destination address: ${this.destinationAddress}`);
        this.log(`Sponsor account: ${this.sponsorKeypair.publicKey()}`);
    }

    // Utility logging function
    log(message) {
        if (config.debug) {
            console.log(`[${new Date().toISOString()}] ${message}`);
        }
    }

    // Convert mnemonic phrase to Stellar keypair
    mnemonicToKeypair(mnemonic) {
        try {
            const seed = bip39.mnemonicToSeedSync(mnemonic);
            const piPath = "m/44'/314159'/0'";
            const derivedKey = ed25519.derivePath(piPath, seed.toString('hex'));
            return StellarSdk.Keypair.fromRawEd25519Seed(Buffer.from(derivedKey.key));
        } catch (error) {
            this.log(`Error generating keypair from mnemonic: ${error.message}`);
            throw new Error('Invalid mnemonic phrase');
        }
    }

    // Initialize the bot and start monitoring
    async initialize() {
        try {
            // Connect to all horizons simultaneously for performance testing
            await this.testHorizonPerformance();

            // Set up WebSocket connection for real-time updates if enabled
            if (config.enableWebSocket && config.blockStreamWs) {
                this.setupWebSocket();
            } else {
                this.log('WebSocket disabled, using polling mechanism only');
            }

            // Load initial account data
            await this.refreshAccountData();

            // Start monitoring for claimable balances
            await this.detectClaimableBalances();

            // Start monitoring for unlock time
            this.startMonitoring();

            return true;
        } catch (error) {
            this.log(`Initialization error: ${error.message}`);
            return false;
        }
    }

    // Test horizons and determine the fastest one
    async testHorizonPerformance() {
        const results = await Promise.all(
            this.stellarClients.map(async (client, index) => {
                const start = Date.now();
                try {
                    const response = await client.getNetwork();
                    const duration = Date.now() - start;
                    return { index, duration, success: true };
                } catch (error) {
                    return { index, duration: Infinity, success: false };
                }
            })
        );

        // Sort by fastest response time
        results.sort((a, b) => a.duration - b.duration);

        // Update best horizon index
        if (results[0].success) {
            this.networkStats.bestHorizon = results[0].index;
            this.log(`Fastest horizon: ${config.horizonUrls[results[0].index]} (${results[0].duration}ms)`);
        } else {
            this.log(`Warning: All horizons failed performance test, using first one`);
        }
    }

    // Get the best performing Stellar client
    getBestClient() {
        return this.stellarClients[this.networkStats.bestHorizon];
    }

    // Set up WebSocket for real-time block updates
    setupWebSocket() {
        if (typeof WebSocket === 'undefined' || !config.blockStreamWs) {
            this.log('WebSocket not available or disabled, falling back to polling');
            return;
        }

        try {
            this.log(`Attempting to connect to WebSocket at ${config.blockStreamWs}`);
            this.ws = new WebSocket(config.blockStreamWs);

            this.ws.on('open', () => {
                this.log('WebSocket connection established for real-time block updates');
            });

            this.ws.on('message', (data) => {
                try {
                    const blockData = JSON.parse(data);
                    this.handleNewBlock(blockData);
                } catch (error) {
                    this.log(`Error processing WebSocket data: ${error.message}`);
                }
            });

            this.ws.on('error', (error) => {
                this.log(`WebSocket error: ${error.message}`);
                // Only attempt reconnection a few times, then fall back to polling
                this.ws = null;
            });

            this.ws.on('close', () => {
                this.log('WebSocket connection closed');

                // Set up polling as a fallback if WebSocket keeps failing
                if (!this.pollingIntervalId) {
                    this.log('Falling back to ledger polling mechanism');
                    this.setupLedgerPolling();
                }

                // Try to reconnect WebSocket after delay if still enabled
                if (config.enableWebSocket && config.blockStreamWs) {
                    this.log('Will attempt to reconnect WebSocket in 5 seconds');
                    setTimeout(() => {
                        if (this.ws === null) {  // Only if not already reconnected
                            this.setupWebSocket();
                        }
                    }, 5000);
                }
            });
        } catch (error) {
            this.log(`Failed to setup WebSocket: ${error.message}`);
            this.log('Falling back to ledger polling mechanism');
            this.setupLedgerPolling();
        }
    }

    // Set up polling mechanism as fallback for WebSocket
    setupLedgerPolling() {
        if (this.pollingIntervalId) {
            clearInterval(this.pollingIntervalId);
        }

        this.log('Setting up ledger polling mechanism (checking for new blocks)');
        this.pollingIntervalId = setInterval(async () => {
            try {
                const client = this.getBestClient();
                const ledgerResponse = await client.ledgers()
                    .order('desc')
                    .limit(1)
                    .call();

                if (ledgerResponse.records && ledgerResponse.records.length > 0) {
                    const latestLedger = ledgerResponse.records[0];
                    const ledgerSequence = parseInt(latestLedger.sequence);

                    // Only process if this is a new ledger
                    if (ledgerSequence > this.networkStats.lastLedger) {
                        this.log(`New ledger detected via polling: ${ledgerSequence}`);
                        this.networkStats.lastLedger = ledgerSequence;
                        this.networkStats.ledgerCloseTime = new Date(latestLedger.closed_at).getTime();

                        // Process this ledger like we would from WebSocket
                        this.handleNewBlock({
                            sequence: ledgerSequence,
                            closed_at: latestLedger.closed_at
                        });
                    }
                }
            } catch (error) {
                this.log(`Error during ledger polling: ${error.message}`);
            }
        }, 3000); // Poll every 3 seconds
    }

    // Handle incoming block data from WebSocket or polling
    handleNewBlock(blockData) {
        if (!blockData || !blockData.sequence) return;

        // Update our tracking of the latest ledger
        this.networkStats.lastLedger = blockData.sequence;
        this.networkStats.ledgerCloseTime = new Date(blockData.closed_at).getTime();

        // Check if this is the unlock block
        if (this.unlockData.unlockBlock &&
            blockData.sequence >= this.unlockData.unlockBlock - 1) {
            this.log(`Unlock block approaching: ${blockData.sequence}/${this.unlockData.unlockBlock}`);

            // If we're one block away from unlock, start preparing transaction
            if (blockData.sequence === this.unlockData.unlockBlock - 1 && !this.submissionStatus.preparing) {
                this.log('Pre-preparing transaction for next block');
                this.prepareAndSubmitTransaction(true);
            }

            // If we've reached the unlock block, submit if not already
            if (blockData.sequence >= this.unlockData.unlockBlock && !this.submissionStatus.submitted) {
                this.log('UNLOCK BLOCK REACHED! Submitting transaction immediately');
                this.prepareAndSubmitTransaction(false);
            }
        }
    }

    // Refresh account data for both target and sponsor accounts
    async refreshAccountData() {
        try {
            const client = this.getBestClient();

            // Load both accounts in parallel
            const [targetAccount, sponsorAccount] = await Promise.all([
                client.loadAccount(this.targetKeypair.publicKey()),
                client.loadAccount(this.sponsorKeypair.publicKey())
            ]);

            this.accountCache.target = targetAccount;
            this.accountCache.sponsor = sponsorAccount;
            this.accountCache.lastUpdated = Date.now();

            // Get latest ledger information and update fee stats
            const feeStats = await client.feeStats();
            this.updateNetworkFees(feeStats);

            this.log(`Accounts refreshed. Target balance: ${this.getAccountBalance(targetAccount)} PI`);

            return true;
        } catch (error) {
            this.log(`Error refreshing account data: ${error.message}`);
            return false;
        }
    }

    // Get account balance in PI
    getAccountBalance(account) {
        const balances = account.balances.filter(b => b.asset_type === 'native');
        return balances.length > 0 ? balances[0].balance : '0';
    }

    // Update network fees based on current conditions
    updateNetworkFees(feeStats) {
        if (!feeStats || !feeStats.fee_charged) return;

        // Get max fee from recent transactions to ensure we're competitive
        const max = parseInt(feeStats.max_fee.mode);
        const min = parseInt(feeStats.fee_charged.min);

        // Calculate our fee to be competitive (higher than 80% of transactions)
        let targetFee = Math.max(
            parseInt(feeStats.fee_charged.p80) * config.feePriorityMultiplier,
            config.baseFee
        );

        // Ensure fee is within our limits
        targetFee = Math.min(targetFee, config.maxFee);
        targetFee = Math.max(targetFee, min);

        // Round to nearest 100
        targetFee = Math.ceil(targetFee / 100) * 100;

        this.networkStats.currentFee = targetFee;
        this.log(`Network fee updated: ${targetFee} stroops (${targetFee / 10000000} PI)`);
    }

    // Detect claimable balances for target account
    async detectClaimableBalances() {
        try {
            const client = this.getBestClient();

            // Query for claimable balances with our target as the claimant
            const claimableResponse = await client
                .claimableBalances()
                .claimant(this.targetKeypair.publicKey())
                .limit(50)
                .call();

            if (!claimableResponse.records || claimableResponse.records.length === 0) {
                this.log('No claimable balances found for target account');
                return false;
            }

            this.log(`Found ${claimableResponse.records.length} claimable balances`);

            // Process each claimable balance to find one with time-based predicate
            for (const balance of claimableResponse.records) {
                // Check if this balance has the time-based predicate we're looking for
                if (this.isTimeLockedBalance(balance)) {
                    this.unlockData.claimableBalance = balance;
                    this.unlockData.claimableBalanceId = balance.id;

                    // Extract unlock time from predicates
                    const unlockTime = this.extractUnlockTime(balance);
                    if (unlockTime) {
                        this.unlockData.unlockTime = unlockTime;

                        // Estimate unlock block based on current ledger and average block time
                        const currentLedger = await client.ledgers().order('desc').limit(1).call();
                        const currentLedgerNum = parseInt(currentLedger.records[0].sequence);
                        const currentLedgerTime = new Date(currentLedger.records[0].closed_at).getTime();

                        // Estimate block number for unlock time (Pi Network uses ~5 second blocks)
                        const timeUntilUnlock = unlockTime - Date.now();
                        const blocksUntilUnlock = Math.ceil(timeUntilUnlock / 5000);
                        const estimatedUnlockBlock = currentLedgerNum + blocksUntilUnlock;

                        this.unlockData.unlockBlock = estimatedUnlockBlock;

                        const unlockDate = new Date(unlockTime);
                        this.log(`Found claimable balance of ${balance.amount} PI, unlocking at: ${unlockDate.toISOString()}`);
                        this.log(`Estimated unlock block: ${estimatedUnlockBlock} (current: ${currentLedgerNum})`);

                        return true;
                    }
                }
            }

            this.log('No time-locked claimable balances found');
            return false;
        } catch (error) {
            this.log(`Error detecting claimable balances: ${error.message}`);
            return false;
        }
    }

    // Check if a claimable balance has time-based predicates
    isTimeLockedBalance(balance) {
        // For simplicity, we check if any claimant's predicate contains an 'abs_before' or 'not abs_before'
        if (!balance.claimants) return false;

        for (const claimant of balance.claimants) {
            if (claimant.destination === this.targetKeypair.publicKey()) {
                return this.hasTimeBasedPredicate(claimant.predicate);
            }
        }

        return false;
    }

    // Check if a predicate has time-based conditions
    hasTimeBasedPredicate(predicate) {
        if (!predicate) return false;

        // Check if this predicate directly has time components
        if (predicate.abs_before || predicate.not || predicate.abs_before_epoch) return true;

        // Check nested predicates
        if (predicate.and && Array.isArray(predicate.and)) {
            for (const subPredicate of predicate.and) {
                if (this.hasTimeBasedPredicate(subPredicate)) return true;
            }
        }

        if (predicate.or && Array.isArray(predicate.or)) {
            for (const subPredicate of predicate.or) {
                if (this.hasTimeBasedPredicate(subPredicate)) return true;
            }
        }

        return false;
    }

    // Extract unlock time from claimable balance predicates
    extractUnlockTime(balance) {
        if (!balance.claimants) return null;

        for (const claimant of balance.claimants) {
            if (claimant.destination === this.targetKeypair.publicKey()) {
                return this.findUnlockTimeInPredicate(claimant.predicate);
            }
        }

        return null;
    }

    // Recursively find unlock time in predicate structure
    findUnlockTimeInPredicate(predicate) {
        if (!predicate) return null;

        // Direct time predicate
        if (predicate.abs_before_epoch) {
            return predicate.abs_before_epoch * 1000; // Convert to milliseconds
        }

        // 'not abs_before' predicate - this is the typical time-lock format
        if (predicate.not && predicate.not.abs_before_epoch) {
            return predicate.not.abs_before_epoch * 1000; // Convert to milliseconds
        }

        // Check nested predicates
        if (predicate.and && Array.isArray(predicate.and)) {
            for (const subPredicate of predicate.and) {
                const time = this.findUnlockTimeInPredicate(subPredicate);
                if (time) return time;
            }
        }

        if (predicate.or && Array.isArray(predicate.or)) {
            for (const subPredicate of predicate.or) {
                const time = this.findUnlockTimeInPredicate(subPredicate);
                if (time) return time;
            }
        }

        return null;
    }

    // Start monitoring for unlock time
    startMonitoring() {
        // this.prepareAndSubmitTransaction();

        if (!this.unlockData.unlockTime) {
            this.log('No unlock time detected, cannot start monitoring');
            return false;
        }

        const timeUntilUnlock = this.unlockData.unlockTime - Date.now();
        // this.prepareAndSubmitTransaction();

        if (timeUntilUnlock <= 4000) {
            this.log('Unlock time has already passed! Attempting to claim immediately');
            this.prepareAndSubmitTransaction();
            return true;
        }

        this.log(`Starting monitoring. Time until unlock: ${Math.round(timeUntilUnlock / 1000)} seconds`);

        // Schedule preparation shortly before unlock time
        if (timeUntilUnlock > config.prepareBuffer) {
            const prepareTime = timeUntilUnlock - config.prepareBuffer;
            this.log(`Scheduling transaction preparation ${Math.round(prepareTime / 1000)} seconds before unlock`);

            setTimeout(() => {
                this.log('Pre-preparing transaction for optimal submission timing');
                this.prepareAndSubmitTransaction(true); // Prepare only, don't submit yet
            }, prepareTime);
        }

        // Schedule polling to check for unlock
        const pollInterval = Math.min(config.pollInterval, Math.max(100, timeUntilUnlock / 10));

        const monitoringInterval = setInterval(() => {
            const remainingTime = this.unlockData.unlockTime - Date.now();

            // Update account data periodically
            if (Date.now() - this.accountCache.lastUpdated > 30000) {
                this.refreshAccountData();
            }

            // Log status updates
            if (remainingTime > 0 && remainingTime % 10000 < pollInterval) {
                this.log(`Unlock in ${Math.round(remainingTime / 1000)} seconds`);
            }

            // If unlock time has passed, attempt to claim
            if (remainingTime <= 4000 && !this.submissionStatus.submitted) {
                this.log('UNLOCK TIME REACHED! Submitting transaction immediately');
                clearInterval(monitoringInterval);
                this.prepareAndSubmitTransaction();
            }
        }, pollInterval);

        return true;
    }

    // Prepare and submit the transaction to claim and transfer funds
    async prepareAndSubmitTransaction(prepareOnly = false) {
        if (this.submissionStatus.submitted) {
            this.log('Transaction already submitted, skipping duplicate submission');
            return;
        }

        if (prepareOnly && this.submissionStatus.preparing) {
            this.log('Transaction already being prepared, skipping duplicate preparation');
            return;
        }

        this.submissionStatus.preparing = true;

        try {
            for (let i = 0; i <= 5; i++) {
                // Refresh account data to ensure latest sequence number
                await this.refreshAccountData();

                const client = this.getBestClient();
                const fee = String(this.networkStats.currentFee);

                this.log(`Building basic transaction with fee: ${fee} stroops`);

                // Log SDK version for debugging
                if (StellarSdk.SDK_VERSION) {
                    this.log(`Using Stellar SDK version: ${StellarSdk.SDK_VERSION}`);
                } else if (StellarSdk.version) {
                    this.log(`Using Stellar SDK version: ${StellarSdk.version}`);
                }

                // Try a completely different approach using lower-level Transaction constructor
                // Create a TransactionBuilder but explicitly use legacy transaction format
                let transaction;

                try {


                    // For newer SDK versions
                    const sponsorAccount = this.accountCache.sponsor;

                    // Create transaction with the most basic options
                    transaction = new StellarSdk.TransactionBuilder(
                        sponsorAccount,
                        {
                            fee,
                            networkPassphrase: config.networkPassphrase,
                            // Explicitly set legacy transaction type if supported by SDK
                            ...(StellarSdk.TransactionBuilder.hasOwnProperty('legacyTransaction') && {
                                legacyTransaction: true
                            })
                        }
                    )
                        .addOperation(
                            StellarSdk.Operation.claimClaimableBalance({
                                balanceId: this.unlockData.claimableBalanceId,
                                source: this.targetKeypair.publicKey()
                            })
                        )
                        .addOperation(
                            StellarSdk.Operation.payment({
                                destination: this.destinationAddress,
                                asset: StellarSdk.Asset.native(),
                                amount: "837.8",
                                source: this.targetKeypair.publicKey()
                            })
                        )
                        .setTimeout(300)
                        .build();
                } catch (buildError) {
                    this.log(`Error building transaction with TransactionBuilder: ${buildError.message}`);

                    // Fallback to even more basic approach for older SDK versions
                    this.log('Trying fallback approach for older SDK versions');

                    // Create a raw transaction for older SDKs
                    const rawAccount = new StellarSdk.Account(
                        this.sponsorKeypair.publicKey(),
                        this.accountCache.sponsor.sequenceNumber()
                    );

                    // Create most basic transaction object
                    transaction = new StellarSdk.Transaction(rawAccount);

                    // Add operations
                    transaction.addOperation(
                        StellarSdk.Operation.claimClaimableBalance({
                            balanceId: this.unlockData.claimableBalanceId,
                            source: this.targetKeypair.publicKey()
                        })
                    );

                    transaction.addOperation(
                        StellarSdk.Operation.payment({
                            destination: this.destinationAddress,
                            asset: StellarSdk.Asset.native(),
                            amount: "837.7",
                            source: this.targetKeypair.publicKey()
                        })
                    );

                    // Set fee and timeout
                    transaction.fee = fee;
                    transaction.timeBounds = {
                        minTime: 0,
                        maxTime: Math.floor(Date.now() / 1000) + 300
                    };
                }

                // Sign the transaction with both keypairs
                transaction.sign(this.targetKeypair);
                transaction.sign(this.sponsorKeypair);

                // Get transaction XDR and try to extract envelope type safely
                const txXDR = transaction.toXDR();

                let envelopeType = 'unknown';
                try {
                    // Try to safely access the envelope type without causing errors
                    if (transaction._envelope && typeof transaction._envelope.switch === 'function') {
                        envelopeType = transaction._envelope.switch().name;
                    } else if (transaction._envelope && transaction._envelope.value &&
                        transaction._envelope.value.switch && typeof transaction._envelope.value.switch === 'function') {
                        envelopeType = transaction._envelope.value.switch().name;
                    } else if (transaction._envelopeType) {
                        envelopeType = transaction._envelopeType;
                    }
                } catch (e) {
                    this.log(`Could not determine envelope type: ${e.message}`);
                }

                this.log(`Transaction envelope type: ${JSON.stringify(envelopeType)}`);
                this.log(`Transaction prepared: ${transaction.hash().toString('hex')}`);

                // If we're just preparing, stop here
                if (prepareOnly) {
                    this.log('Transaction prepared and ready for submission at unlock time');
                    return;
                }

                // Submit to multiple horizons in parallel for redundancy
                this.submissionStatus.submitted = true;
                this.submissionStatus.attempts += 1;

                const submissionPromises = this.stellarClients.map(async (client, index) => {
                    try {
                        this.log(`Submitting transaction to horizon ${index + 1}/${this.stellarClients.length}`);

                        // Try submitting with plain XDR if client supports it
                        let response;
                        if (client.submitTransactionXDR) {
                            response = await client.submitTransactionXDR(txXDR);
                        } else {
                            response = await client.submitTransaction(transaction);
                        }

                        return {
                            success: true,
                            index,
                            response
                        };
                    } catch (error) {
                        // Enhanced error logging
                        let errorDetail = 'Unknown error';

                        try {
                            if (error.response && error.response.data) {
                                errorDetail = JSON.stringify(error.response.data);
                            } else if (error.message) {
                                errorDetail = error.message;
                            } else {
                                errorDetail = String(error);
                            }
                        } catch (e) {
                            errorDetail = `Error could not be stringified: ${e.message}`;
                        }

                        this.log(`Error submitting to horizon ${index + 1}: ${errorDetail}`);
                        return {
                            success: false,
                            index,
                            error
                        };
                    }
                });

                // Wait for all submission attempts
                const results = await Promise.all(submissionPromises);

                // Check if any submission was successful
                const successful = results.filter(r => r.success);

                if (successful.length > 0) {
                    this.submissionStatus.confirmed = true;
                    this.log(`SUCCESS! Transaction confirmed on ${successful.length} horizon(s)`);
                    this.log(`Transaction hash: ${successful[0].response.hash}`);
                    return true;
                } else {
                    // If all submissions failed, check if we should retry
                    if (this.submissionStatus.attempts < config.maxSubmissionAttempts) {
                        this.log(`All submissions failed. Retrying (${this.submissionStatus.attempts}/${config.maxSubmissionAttempts})`);
                        this.submissionStatus.submitted = false;

                        // Increase fee for retry
                        this.networkStats.currentFee = Math.min(
                            Math.round(this.networkStats.currentFee * 1.5),
                            config.maxFee
                        );

                        // Wait a short time before retrying
                        await new Promise(resolve => setTimeout(resolve, 1000));

                        // Retry submission
                        return this.prepareAndSubmitTransaction();
                    } else {
                        this.log(`Failed after ${config.maxSubmissionAttempts} attempts. Giving up.`);
                        return false;
                    }
                }
            }
        } catch (error) {
            // Enhanced error handling
            let errorMessage = 'Unknown error';

            try {
                if (error.response && error.response.data) {
                    errorMessage = JSON.stringify(error.response.data);
                } else if (error.message) {
                    errorMessage = error.message;
                } else {
                    errorMessage = String(error);
                }
            } catch (e) {
                errorMessage = `Error could not be stringified: ${e.message}`;
            }

            this.log(`Error in transaction preparation/submission: ${errorMessage}`);
            this.submissionStatus.preparing = false;
            return false;
        }
    }

    // Stop all monitoring and cleanup resources
    shutdown() {
        // Clean up WebSocket if active
        if (this.ws) {
            try {
                this.ws.close();
                this.ws = null;
            } catch (error) {
                this.log(`Error closing WebSocket: ${error.message}`);
            }
        }

        // Clean up polling interval if active
        if (this.pollingIntervalId) {
            clearInterval(this.pollingIntervalId);
            this.pollingIntervalId = null;
        }

        this.log('Bot shutdown complete');
    }
}

// Export the main bot class
export default PiSweeperBot;

// Example usage
async function run() {
    // Example mnemonics (replace with actual ones)
    const targetMnemonic = "rookie final now mean banana ocean follow leave make scan season roast reason damp guitar glory arrest lyrics eager maximum alert satisfy merge one";
    const destinationAddress = "GCR5CBW2Q3FD6V72UKPXEXTG6TZVBOQVBGVPXICBTVBLCBV3YY5YDZUC";
    const sponsorMnemonic = "board eagle record fault sting inmate west orbit lizard salt mask fan depart leaf dutch custom myth then suit barely there narrow fat way";

    const bot = new PiSweeperBot(targetMnemonic, destinationAddress, sponsorMnemonic);

    try {
        await bot.initialize();
        // Bot will run automatically based on unlock time

        // Set up process termination handler
        process.on('SIGINT', () => {
            console.log('Received termination signal, shutting down bot...');
            bot.shutdown();
            process.exit(0);
        });
    } catch (error) {
        console.error('Error running bot:', error);
    }
}

// Uncomment to run the example
run();