import StellarSdk from 'stellar-sdk';
import bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const keypairFromPassphrase = (passphrase) => {
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

        let derivationPath = "m/44'/314159'/0'"

        // Derive the ED25519 key using the path
        const derivedKey = derivePath(derivationPath, seed.toString('hex'));

        // Create Stellar keypair from the derived private key
        return StellarSdk.Keypair.fromRawEd25519Seed(Buffer.from(derivedKey.key));
    } catch (error) {
        console.error('Error deriving keypair from passphrase:', error);
        throw new Error(`Failed to derive keypair: ${error.message}`);
    }
}
const transaction = async () => {
    try {

        let horizonUrl = 'https://api.mainnet.minepi.com'
        let server = new StellarSdk.Server(horizonUrl);

        let sourceKeypair = keypairFromPassphrase('rookie final now mean banana ocean follow leave make scan season roast reason damp guitar glory arrest lyrics eager maximum alert satisfy merge one')
        let sponsorKeypair = keypairFromPassphrase('coach sun mesh avocado twenty dance august wrap lumber cupboard retire faith canal few alone seek notice hawk multiply theory proof tell cable sure')

        let sponsorAccount = await server.loadAccount(sponsorKeypair.publicKey())
        let sourceAccount = await server.loadAccount(sourceKeypair.publicKey())

        let targetAddress = "GCXHMA3JBS4AWDKDOKXKCJFJZQIUW4PVINQ7G4VTPFSAXACBIRXGQXAF"

        console.log("Sponsor Account:", targetAddress);

        const currentSequence = BigInt(sourceAccount.sequenceNumber());
        const newSequence = (currentSequence + BigInt(1)).toString();

        console.log("Current Sequence:", currentSequence.toString());

        let feeStats = await server.feeStats()
        let sourcePublicKey = sourceKeypair.publicKey()

        let networkPassphrase = "Pi Network"

        let ledger = await server.ledgers()
            .order('desc')
            .limit(1)
            .call();
        let closedAt = new Date(ledger.records[0].closed_at).getTime() / 1000;
        let minTime = Math.floor(closedAt);  // 5-second buffer
        let maxTime = minTime + 600;

        const txBuilder = new StellarSdk.TransactionBuilder(sourceAccount, {
            fee: 0,
            networkPassphrase: "Pi Network",
            timebounds: {
                minTime: minTime.toString(),
                maxTime: maxTime.toString()
            }
        })

        // txBuilder.addOperation(StellarSdk.Operation.claimClaimableBalance({
        //     balanceId: this.claimableBalanceId
        // }))

        txBuilder.addOperation(StellarSdk.Operation.pathPaymentStrictSend({
            sendAsset: StellarSdk.Asset.native(),
            sendAmount: "1", // This is a placeholder, actual amount limited by balance
            destination: targetAddress,
            destAsset: StellarSdk.Asset.native(),
            destMin: "0.0000001" // Ensure transaction succeeds even with small amounts
        }));



        const tx = txBuilder.build();

        tx.sign(sourceKeypair);

        const feeBumpTx = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
            sponsorKeypair,
            feeStats.max_fee.max.toString() * 6,
            tx,
            networkPassphrase
        );

        // Sign with sponsor account
        feeBumpTx.sign(sponsorKeypair);
        let finalTx = feeBumpTx;

        console.log("WAKAK")
        await server.submitTransaction(finalTx);
    }
    catch (error) {
        console.error('Error in transaction:', error.response.data);
        throw error
    }
}

async function main() {
    let txns = []
    for (let i = 0; i < 5; i++) {
        console.log("Transaction", i + 1);
        txns.push(transaction().then(() => {
            console.log("Transaction", i + 1, "completed");
        }).catch((error) => {
            console.error("Transaction", i + 1, "failed:", error);
        }));
        await sleep(40);
    }

    await Promise.all(txns);
}
main()

