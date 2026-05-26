# zafe-sdk

**Private SOL transfers on Solana for AI agents and developers. ZK-powered, non-custodial, one function call.**

Built on [Zafe Protocol](https://zafe.network) - the privacy layer for Solana.

---

## Install

```bash
npm install zafe-sdk
```

---

## Usage

```js
import { transfer } from 'zafe-sdk';

const result = await transfer(senderKeypair, 'RecipientAddress', 1.0);

console.log(result.depositTx);   // deposit transaction
console.log(result.withdrawTx);  // withdrawal transaction (no link to deposit)
console.log(result.amount);      // SOL received by recipient
```

That's it. Sender and recipient are never linked on-chain.

---

## Multi-recipient

One deposit. Multiple private withdrawals. Each with its own delay.

```js
import { multiTransfer } from 'zafe-sdk';

await multiTransfer(
  senderKeypair,
  ['Wallet1...', 'Wallet2...', 'Wallet3...'],
  [0.5, 1.0, 2.0],
  {
    delays: [0, 30000, 60000],  // per-recipient delay in ms
    log: console.log,
  }
);
```

---

## Options

```js
await transfer(sender, recipient, amount, {
  rpcUrl: 'https://your-rpc.com',  // custom RPC
  delay:  30000,                    // ms before withdrawal (default: 15000)
  log:    console.log,              // logging
});
```

---

## What you can do with it

**Users** - send SOL to any wallet with no on-chain link between sender and recipient.

**AI Agents** - drop private payments into any agentic workflow. No wallet adapter, no browser, no UI required.

**Developers & Builders** - add financial privacy to any app, protocol, or script with two lines of code.

---

## How it works

Powered by [Zafe Protocol](https://zafe.network):

1. Sender deposits SOL into the Zafe vault (sender signs once)
2. A ZK commitment note is generated - only you have it
3. A Groth16 ZK-SNARK proof is generated server-side
4. An independent relayer withdraws to the recipient - your wallet never signs the exit
5. Zero on-chain link. Cryptographically unlinkable.

---

## Limits

- Minimum: **0.01 SOL**
- Maximum: **50 SOL**
- Multi-transfer: up to **10 recipients**
- Fee: **0.5%** (free for wallets holding 10,000+ $BONK)

---

[zafe.network](https://zafe.network) · [@ZafeNetwork](https://x.com/ZafeNetwork)
