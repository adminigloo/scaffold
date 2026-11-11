# @adminigloo/wallet

Spendable balances. A purchase puts credits in someone's account, the app
spends them, and nothing ever goes below zero or counts twice.

- A catalog **`credits` grant** (`{ unit: "crowns", amount: 25 }`) on a
  variant credits the buyer when the order is booked, inside the booking
  transaction (create-app's `fulfilPurchase`).
- **Several kinds of credit side by side**, each named by a unit slug
  (`crowns`, `ai-credits`).
- **One statement per movement.** A spend is one conditional UPDATE ("take five
  if there are five") plus its ledger row. It is atomic alone and inside a
  caller's transaction, and it needs no interactive transaction, so it works
  over Neon's HTTP driver too.
- **Idempotent by reference.** Every movement is keyed on
  `(holder, unit, reason, ref)` by a unique index. A redelivered webhook, a
  double click, or the webhook and the page both settling one payment move the
  balance once.
- **An append-only ledger**: `grant`, `spend`, `refund`, `adjust`. The
  balances always equal the ledger's sum.

## Entry points

| Import | What |
| --- | --- |
| `@adminigloo/wallet` | `formatCredits`, unit and amount checks, the refusals, `walletPermissions`. Safe in a browser. |
| `@adminigloo/wallet/schema` | `walletBalances`, `walletLedger`, `walletSchema` |
| `@adminigloo/wallet/server` | `creditWallet`, `spendWallet`, `refundWallet`, `adjustWallet`, `walletBalance`, `balancesOf`, `listWallets`, `listWalletLedger` |

`sql/wallet-0.1.0.sql` creates the tables for a project that doesn't run
drizzle-kit.

## Spending

```ts
import { spendWallet } from "@adminigloo/wallet/server";
import { InsufficientCreditsError } from "@adminigloo/wallet";

try {
  const { balance } = await spendWallet(db, {
    holderId: user.id,
    unit: "crowns",
    amount: item.crowns,
    ref: `bar-order:${orderId}`, // what it was spent on: unique per holder
  });
} catch (error) {
  if (error instanceof InsufficientCreditsError) {
    // error.balance is what they hold: offer the pack that makes up the rest
  }
  throw error;
}
```

A spend with a `ref` that already spent returns `{ applied: false }` with the
balance as it stands. It never spends twice, and never reads as "not enough"
just because the first one emptied the purse.

## Who a holder is

`holder_id` is plain text with no foreign key. The shop's fulfilment credits
the **buyer's user id**, which is what a consumer app wants. A company app can
keep wallets per company by crediting the tenant id instead. The package
doesn't guess.

A `credits` grant needs a buyer. A guest purchase of a credits product is
refused before checkout, and refused again at fulfilment if it gets there.

## Refunds

`refundWallet` takes back what's left of what a purchase granted, never below
zero. It always records a ledger row, a zero row if nothing was left. So a
second refund of the same order is a no-op, not a second try at credits
bought since.

## Staff

`walletPermissions`:

| Key | Who holds it by default |
| --- | --- |
| `credits.balances.view` | admin, cs_lead, cs_agent |
| `credits.balances.adjust` | admin |

`adjustWallet` needs a note and an actor, and refuses to take away more than is
held. The caller writes the audit row, in the same transaction. create-app's
`/admin/credits` does both.
