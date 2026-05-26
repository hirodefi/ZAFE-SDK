// @zafe/sdk — Private SOL transfers on Solana
// Powered by Zafe Protocol (zafe.network)
// V1 — Single and multi-recipient private transfers

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import axios from 'axios';

const ZAFE_API      = 'https://zafe.network/api';
const ZAFE_RPC      = 'https://zafe.network/rpc';
const DEPOSIT_DISC  = Buffer.from([0xf2, 0x23, 0xc6, 0x89, 0x52, 0xe1, 0xf2, 0xb6]);
const DEFAULT_DELAY = 15000; // 15s between deposit and withdrawal

// ─── SINGLE TRANSFER ─────────────────────────────────────────────────────────

/**
 * Send SOL privately from sender to a single recipient through Zafe Protocol.
 * Zero on-chain link between sender and recipient.
 *
 * @param {Keypair}  senderKeypair  - Solana Keypair of the sender
 * @param {string}   recipient      - Destination wallet address (base58)
 * @param {number}   amountSOL      - Amount in SOL (0.01 – 50)
 * @param {object}   options
 * @param {string}   [options.rpcUrl]  - Custom RPC (default: zafe.network/rpc)
 * @param {number}   [options.delay]   - ms to wait before withdrawal (default: 15000)
 * @param {function} [options.log]     - Logger fn (default: silent)
 * @returns {{ depositTx: string, withdrawTx: string, amount: number }}
 */
export async function transfer(senderKeypair, recipient, amountSOL, options = {}) {
  const {
    rpcUrl = ZAFE_RPC,
    delay  = DEFAULT_DELAY,
    log    = () => {},
  } = options;

  const connection = new Connection(rpcUrl, 'confirmed');

  // ── 1. Fetch config + fee info ───────────────────────────────────────────
  const [{ data: config }, { data: feeInfo }] = await Promise.all([
    axios.get(`${ZAFE_API}/config`),
    axios.get(`${ZAFE_API}/check-fee/${senderKeypair.publicKey.toBase58()}`),
  ]);

  const programId = new PublicKey(config.programId);
  const zafePDA   = new PublicKey(config.zafe);
  const vaultPDA  = new PublicKey(config.vault);

  log(`[zafe] program: ${config.programId}`);
  log(`[zafe] fee: ${feeInfo.exempt ? '0% (exempt)' : feeInfo.feePercent + '%'}`);

  // ── 2. Prepare deposit ───────────────────────────────────────────────────
  const { data: prepared } = await axios.post(`${ZAFE_API}/deposit/prepare`, {
    amount: amountSOL,
  });
  const { commitment, note } = prepared;

  // ── 3. Derive commitment PDA ─────────────────────────────────────────────
  const zafeAccount = await connection.getAccountInfo(zafePDA);
  if (!zafeAccount) throw new Error('[zafe] Zafe state account not found on-chain');
  const nextIndex = zafeAccount.data.readUInt32LE(104);

  const idxBuf = Buffer.alloc(4);
  idxBuf.writeUInt32LE(nextIndex);
  const [commitPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('commitment'), zafePDA.toBuffer(), idxBuf],
    programId
  );

  // ── 4. Build + send deposit transaction ─────────────────────────────────
  const commitBytes = Buffer.from(commitment, 'hex');
  const amtBytes    = Buffer.alloc(8);
  amtBytes.writeBigUInt64LE(BigInt(Math.round(amountSOL * LAMPORTS_PER_SOL)));

  const depositIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: zafePDA,                 isSigner: false, isWritable: true  },
      { pubkey: vaultPDA,                isSigner: false, isWritable: true  },
      { pubkey: commitPDA,               isSigner: false, isWritable: true  },
      { pubkey: senderKeypair.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DEPOSIT_DISC, commitBytes, amtBytes]),
  });

  const tx = new Transaction().add(depositIx);

  // Attach fee if not exempt
  const feeLamports = feeInfo.exempt
    ? 0
    : Math.round(amountSOL * (feeInfo.feePercent / 100) * LAMPORTS_PER_SOL);

  if (feeLamports > 0) {
    tx.add(SystemProgram.transfer({
      fromPubkey: senderKeypair.publicKey,
      toPubkey:   new PublicKey(feeInfo.feeWallet),
      lamports:   feeLamports,
    }));
  }

  log(`[zafe] sending deposit...`);
  const depositTx = await sendAndConfirmTransaction(connection, tx, [senderKeypair], {
    skipPreflight: true,
    commitment: 'confirmed',
  });
  log(`[zafe] deposit confirmed: ${depositTx}`);

  // ── 5. Confirm deposit with backend ──────────────────────────────────────
  await retryPost(`${ZAFE_API}/deposit/confirm`, {
    commitment,
    amount:      amountSOL,
    txSignature: depositTx,
    depositor:   senderKeypair.publicKey.toBase58(),
  }, 10, 3000, '[zafe] deposit confirmation failed after 10 attempts');

  // ── 6. Wait before withdrawal ─────────────────────────────────────────────
  if (delay > 0) {
    log(`[zafe] waiting ${delay / 1000}s before withdrawal...`);
    await sleep(delay);
  }

  // ── 7. Withdraw ───────────────────────────────────────────────────────────
  log(`[zafe] withdrawing to ${recipient}...`);
  const { data: withdrawal } = await axios.post(`${ZAFE_API}/withdraw`, {
    note:      { secret: note.secret, nullifier: note.nullifier },
    recipient,
  });
  log(`[zafe] done: ${withdrawal.txSignature} — ${withdrawal.amount} SOL sent`);

  return {
    depositTx,
    withdrawTx: withdrawal.txSignature,
    amount:     withdrawal.amount,
  };
}

// ─── MULTI-RECIPIENT TRANSFER ─────────────────────────────────────────────────

/**
 * Deposit once and withdraw to multiple recipients privately.
 * One deposit tx from sender; separate private withdrawals to each recipient.
 *
 * @param {Keypair}   senderKeypair  - Solana Keypair of the sender
 * @param {string[]}  recipients     - Array of destination wallet addresses (max 10)
 * @param {number[]}  amounts        - SOL amount per recipient (matches index)
 * @param {object}    options
 * @param {string}    [options.rpcUrl]   - Custom RPC
 * @param {number[]}  [options.delays]   - Per-recipient delay in ms (default: 15000 each)
 * @param {function}  [options.log]      - Logger fn
 * @returns {{ depositTx: string, withdrawals: Array<{ recipient, txSignature, amount }> }}
 *
 * @example
 * await multiTransfer(sender, ['Alice...', 'Bob...'], [0.5, 1.0], {
 *   delays: [0, 60000],  // Alice instant, Bob after 1 min
 * });
 */
export async function multiTransfer(senderKeypair, recipients, amounts, options = {}) {
  if (!Array.isArray(recipients) || !Array.isArray(amounts)) {
    throw new Error('[zafe] recipients and amounts must be arrays');
  }
  if (recipients.length !== amounts.length) {
    throw new Error('[zafe] recipients and amounts must be the same length');
  }
  if (recipients.length === 0 || recipients.length > 10) {
    throw new Error('[zafe] must have 1–10 recipients');
  }

  const {
    rpcUrl = ZAFE_RPC,
    delays = recipients.map(() => DEFAULT_DELAY),
    log    = () => {},
  } = options;

  const totalSOL = amounts.reduce((a, b) => a + b, 0);
  const connection = new Connection(rpcUrl, 'confirmed');

  // ── 1. Config + fee ──────────────────────────────────────────────────────
  const [{ data: config }, { data: feeInfo }] = await Promise.all([
    axios.get(`${ZAFE_API}/config`),
    axios.get(`${ZAFE_API}/check-fee/${senderKeypair.publicKey.toBase58()}`),
  ]);

  const programId = new PublicKey(config.programId);
  const zafePDA   = new PublicKey(config.zafe);
  const vaultPDA  = new PublicKey(config.vault);

  log(`[zafe] multi-transfer: ${recipients.length} recipients, ${totalSOL} SOL total`);
  log(`[zafe] fee: ${feeInfo.exempt ? '0% (exempt)' : feeInfo.feePercent + '%'}`);

  // ── 2. Prepare deposit ───────────────────────────────────────────────────
  const { data: prepared } = await axios.post(`${ZAFE_API}/deposit/prepare`, {
    amount: totalSOL,
  });
  const { commitment, note } = prepared;

  // ── 3. Commitment PDA ────────────────────────────────────────────────────
  const zafeAccount = await connection.getAccountInfo(zafePDA);
  if (!zafeAccount) throw new Error('[zafe] Zafe state account not found on-chain');
  const nextIndex = zafeAccount.data.readUInt32LE(104);

  const idxBuf = Buffer.alloc(4);
  idxBuf.writeUInt32LE(nextIndex);
  const [commitPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from('commitment'), zafePDA.toBuffer(), idxBuf],
    programId
  );

  // ── 4. Deposit tx ────────────────────────────────────────────────────────
  const commitBytes = Buffer.from(commitment, 'hex');
  const amtBytes    = Buffer.alloc(8);
  amtBytes.writeBigUInt64LE(BigInt(Math.round(totalSOL * LAMPORTS_PER_SOL)));

  const depositIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: zafePDA,                 isSigner: false, isWritable: true  },
      { pubkey: vaultPDA,                isSigner: false, isWritable: true  },
      { pubkey: commitPDA,               isSigner: false, isWritable: true  },
      { pubkey: senderKeypair.publicKey, isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DEPOSIT_DISC, commitBytes, amtBytes]),
  });

  const tx = new Transaction().add(depositIx);

  const feeLamports = feeInfo.exempt
    ? 0
    : Math.round(totalSOL * (feeInfo.feePercent / 100) * LAMPORTS_PER_SOL);

  if (feeLamports > 0) {
    tx.add(SystemProgram.transfer({
      fromPubkey: senderKeypair.publicKey,
      toPubkey:   new PublicKey(feeInfo.feeWallet),
      lamports:   feeLamports,
    }));
  }

  log(`[zafe] sending deposit...`);
  const depositTx = await sendAndConfirmTransaction(connection, tx, [senderKeypair], {
    skipPreflight: true,
    commitment: 'confirmed',
  });
  log(`[zafe] deposit confirmed: ${depositTx}`);

  // ── 5. Confirm deposit ───────────────────────────────────────────────────
  await retryPost(`${ZAFE_API}/deposit/confirm`, {
    commitment,
    amount:      totalSOL,
    txSignature: depositTx,
    depositor:   senderKeypair.publicKey.toBase58(),
  }, 10, 3000, '[zafe] deposit confirmation failed after 10 attempts');

  // ── 6. Multi-withdraw (each recipient with its own delay) ─────────────────
  // Schedule each withdrawal independently after its delay
  const withdrawalPromises = recipients.map(async (recipient, i) => {
    const delay = delays[i] ?? DEFAULT_DELAY;
    if (delay > 0) {
      log(`[zafe] recipient ${i + 1} waiting ${delay / 1000}s...`);
      await sleep(delay);
    }
    log(`[zafe] withdrawing to recipient ${i + 1}: ${recipient}`);
    const { data: w } = await axios.post(`${ZAFE_API}/withdraw/multi`, {
      note:       { secret: note.secret, nullifier: note.nullifier },
      recipients: [recipient],
      amounts:    [amounts[i]],
    });
    log(`[zafe] recipient ${i + 1} done: ${w.txSignature}`);
    return { recipient, txSignature: w.txSignature, amount: amounts[i] };
  });

  const withdrawals = await Promise.all(withdrawalPromises);

  return { depositTx, withdrawals };
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function retryPost(url, body, maxAttempts, retryDelay, errorMsg) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      await axios.post(url, body);
      return;
    } catch {
      if (i === maxAttempts) throw new Error(errorMsg);
      await sleep(retryDelay);
    }
  }
}
