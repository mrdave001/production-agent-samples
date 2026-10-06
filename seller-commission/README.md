# Seller commission accrual

## Context

My product has official sellers (resellers) who earn 25% of every payment a referred customer makes in that customer's first 12 months. Each seller has a tracking link; signups through it get attributed at signup. This is the function that turns a Stripe payment event into money owed to a seller.

It runs inside the billing webhook of a live product, which sets every design constraint worth mentioning:

## The constraints, and how each is handled

**Stripe retries events.** The same `invoice.payment_succeeded` can arrive two or three times. The commission document's ID *is* the Stripe invoice ID, and the transaction checks for its existence before writing. A replayed event writes nothing, and the transaction return value keeps the log honest (`accrued = false` means the "commission accrued" log line stays silent on duplicates — that log lied about retries for a day before I fixed it).

**Billing must never break because of this.** The call site (top of the file) is gated on `userData.sellerId`, so the vast majority of users — unattributed — cost zero extra reads. And the whole call is wrapped so a commission failure logs and moves on; the customer's payment record is never at risk.

**The 12-month window has to be trusted.** The window starts at the customer's first *paid* invoice, not at signup, and `$0` trial invoices deliberately do not open it. The start timestamp lives on the user document in a field the security rules block clients from writing — otherwise a customer could reset their own window and keep their seller earning forever. That's the one fraud case I could think of, and the blocklist entry is cheap insurance.

**Everything else is a skip, not an error.** Not a subscription invoice (POS charge), seller missing, seller paused, payment outside the window — each returns quietly. A refund does *not* claw back (v1 decision: gross accrual, netted out manually at payout time; documented in the product rather than half-built).

## Verified, not just written

Before shipping I forged signed `invoice.payment_succeeded` events (HMAC-SHA256 with the webhook secret, POSTed to the local server against production Firestore) and asserted the three cases: a $29 payment accrues exactly 725c, the same event re-sent accrues nothing, and a payment 13 months out creates no document. Then I deleted the fixtures. Forging events is the only way I know to test webhook code without touching live Stripe, and the test script was the same one that later caught a production-only redirect bug.

## File

`accrueSellerCommission.ts` — the function plus the call site as a comment. Extract; imports (`admin`, the route's helpers) elided.