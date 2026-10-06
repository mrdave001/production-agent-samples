/**
 * EXTRACT from the Stripe billing webhook (Next.js route handler, LIVE mode).
 * Called from the invoice.payment_succeeded handler after the existing
 * billing writes, gated so unattributed users cost zero extra reads:
 *
 *   // Official-seller commission accrual. userData (fetched above) is the gate:
 *   // unattributed users — the vast majority — cost zero extra reads. Failure
 *   // must never affect billing processing.
 *   if (userData?.sellerId) {
 *     try {
 *       await accrueSellerCommission(subUserId, invoice, userData);
 *     } catch (e) {
 *       console.error('[webhook] seller commission accrual failed (non-fatal):', e);
 *     }
 *   }
 *
 * Context: sellers (resellers) get a tracking link; customers who sign up
 * through it are attributed. The seller earns 25% of every payment that
 * customer makes in their first 12 months from first payment.
 */

async function accrueSellerCommission(
  subUserId: string,
  invoice: any,
  userData: Record<string, any>
) {
  // Subscription invoices only (POS charges carry no subscription) and skip
  // $0 invoices (trial starts) — they must not open the commission window.
  if (!invoice.subscription) return;
  const amountPaidCents = invoice.amount_paid || 0;
  if (amountPaidCents <= 0) return;

  const sellerId = userData.sellerId;
  if (!sellerId) return;

  const db = admin.firestore();
  const userRef = db.collection('users').doc(subUserId);

  // Anchor the 12-month window at the first paid invoice. ISO strings match
  // the handler's trialEndDate/interruptionDate convention. sellerWindowStart
  // is rules-blocked for clients (webhook-only field).
  let windowStartIso: string | null = userData.sellerWindowStart || null;
  if (!windowStartIso) {
    windowStartIso = new Date().toISOString();
    await userRef.set({ sellerWindowStart: windowStartIso }, { merge: true });
  }

  // Stripe timestamps are seconds; fall back to now for odd payloads.
  const paidAt = invoice.payment_created
    ? new Date(invoice.payment_created * 1000)
    : invoice.created
    ? new Date(invoice.created * 1000)
    : new Date();

  const sellerSnap = await db.collection('sellers').doc(sellerId).get();
  if (!sellerSnap.exists) return;
  const seller = sellerSnap.data() || {};
  if (seller.status !== 'active') return; // paused sellers stop accruing

  const rate = typeof seller.commissionRate === 'number' ? seller.commissionRate : 0.25;
  const windowEnd = new Date(windowStartIso);
  windowEnd.setMonth(windowEnd.getMonth() + (seller.commissionMonths || 12));
  if (paidAt.getTime() > windowEnd.getTime()) return; // outside the first 12 months

  const commissionCents = Math.round(amountPaidCents * rate);

  const commissionRef = sellerSnap.ref
    .collection('commissions')
    .doc(invoice.id);

  const accrued = await db.runTransaction(async (tx) => {
    const existing = await tx.get(commissionRef);
    if (existing.exists) return false; // Stripe retry — already accrued
    tx.set(commissionRef, {
      userId: subUserId,
      invoiceId: invoice.id,
      amountPaidCents,
      commissionCents,
      currency: invoice.currency || 'usd',
      paidAt: paidAt.toISOString(),
      windowEnd: windowEnd.toISOString(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.update(sellerSnap.ref, {
      totalRevenueCents: admin.firestore.FieldValue.increment(amountPaidCents),
      totalCommissionCents: admin.firestore.FieldValue.increment(commissionCents),
      lastActivityAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  if (!accrued) return; // duplicate delivery — nothing changed

  console.log(
    `💰 [seller] ${commissionCents}c commission accrued to seller ${sellerId} (user ${subUserId}, invoice ${invoice.id})`
  );
}