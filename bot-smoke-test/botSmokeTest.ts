/**
 * Nightly bot smoke test.
 *
 * Every past bot regression (Spanish replies to English messages, HIPAA
 * portal links on innocent greetings, silent AI failures falling back to
 * canned text) was found by me manually messaging the bot. This function
 * does that automatically once a day: it drives the REAL message pipeline
 * (processIncomingMessage, not a mock) with a handful of canned test
 * messages, then asserts on what the bot actually stored:
 *
 *   1. a reply was produced at all
 *   2. the AI actually generated it (tokensIn > 0 - not a canned fallback)
 *   3. the reply language matches the message language
 *   4. no HIPAA/portal link is sent
 *   5. no known canned-fallback phrasing leaked out
 *
 * Results land in professionals/{id}/smokeTests (one doc per run). On any
 * failure an alert email goes to the owner via Brevo transactional; successful
 * runs stay silent apart from the structured log.
 *
 * NOTE: test messages really go out over WhatsApp to TEST_CUSTOMER_PHONE -
 * it must be a number the owner controls. Config can be overridden in the
 * Firestore doc config/smokeTest.
 */

import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import { processIncomingMessage } from './lib/aiProcessor';
import { findBusinessByPhone, sendWhatsAppMessage, decrypt } from './lib/whatsapp';
import { detectMessageLanguage } from './lib/messageLanguage';
import { sendTransactionalEmail } from './brevoEmail';
// aiProcessor's failed-payment grounding reads this secret via ../shopify;
// bind it or the lookup silently fails in the smoke test too.
import { shopifyApiSecret } from './shopify';

const db = admin.firestore();

// Placeholder values for this extract - the real config lives in the
// Firestore doc config/smokeTest and overrides all of these at run time.
const DEFAULT_CONFIG = {
  enabled: true,
  businessPhone: '+34600000000',
  // No hardcoded professionalId: the test resolves whichever professional
  // currently owns businessPhone (the same findBusinessByPhone lookup the
  // real pipeline uses). A WhatsApp reconnect under a different account
  // otherwise silently orphans the test against the stale account. Pin an
  // account explicitly via config/smokeTest.professionalId if ever needed.
  resultsHomeProfessionalId: 'REPLACE_WITH_ACCOUNT_ID',
  testCustomerPhone: '+35600000000',
  testCustomerName: 'Smoke Test',
  alertEmail: 'you@example.com',
  // Must comfortably fit 4 sequential AI round-trips (~20s each).
  timeoutSeconds: 480,
};

// Greetings/prices only - deliberately NO booking scenario, so the test can
// never create a real appointment on the business's calendar.
interface SmokeScenario {
  name: string;
  text: string;
  expectedLang: 'en' | 'es';
}

const SCENARIOS: SmokeScenario[] = [
  { name: 'english-greeting', text: 'Hi how are you?', expectedLang: 'en' },
  { name: 'english-pricing', text: 'What are your prices?', expectedLang: 'en' },
  { name: 'spanish-greeting', text: 'Hola, ¿cómo estás? ¿Qué servicios ofrecéis?', expectedLang: 'es' },
  { name: 'spanish-info', text: 'Gracias, buenas tardes. ¿Cuánto cuesta el servicio?', expectedLang: 'es' },
];

// Canned-fallback strings that must never be the customer-visible reply.
const CANNED_MARKERS = ['El equipo de la consulta', 'pondrá en contacto', 'practice team will get back'];

async function readConfig() {
  const snap = await db.collection('config').doc('smokeTest').get();
  const d = snap.exists ? snap.data() || {} : {};
  return {
    enabled: d.enabled !== false,
    businessPhone: d.businessPhone || DEFAULT_CONFIG.businessPhone,
    // undefined = resolve the current owner of the number at run time.
    professionalId: (d.professionalId as string | undefined) || null,
    testCustomerPhone: d.testCustomerPhone || DEFAULT_CONFIG.testCustomerPhone,
    testCustomerName: d.testCustomerName || DEFAULT_CONFIG.testCustomerName,
    alertEmail: d.alertEmail || DEFAULT_CONFIG.alertEmail,
  };
}

interface ScenarioResult {
  name: string;
  pass: boolean;
  reply: string;
  checks: Record<string, { pass: boolean; detail?: string }>;
}

async function runScenario(
  scenario: SmokeScenario,
  cfg: Awaited<ReturnType<typeof readConfig>>
): Promise<ScenarioResult> {
  const convRef = db
    .collection('professionals')
    .doc(cfg.professionalId)
    .collection('conversations')
    .doc(cfg.testCustomerPhone);

  // Snapshot the latest outbound timestamp so we can identify THIS run's reply
  // even if earlier smoke replies sit in the conversation.
  const before = await convRef.collection('messages')
    .where('direction', '==', 'outbound')
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();
  const beforeMs = (before.docs[0]?.data()?.timestamp?.toMillis?.()) || 0;

  const t0 = Date.now();
  const smokeId = `smoke-${t0}-${scenario.name}`;
  await processIncomingMessage(
    cfg.businessPhone,
    cfg.testCustomerPhone,
    scenario.text,
    smokeId,
    cfg.testCustomerName,
    'whatsapp'
  );

  // Flag this run's traffic so the AI never sees it again: aiProcessor's
  // history loaders and contact-memory update skip messages marked smokeTest.
  // The inbound is found by its unique smoke- messageId; the outbound reply by
  // timestamp (anything newer than the pre-run snapshot).
  try {
    const writes: Promise<unknown>[] = [];
    const inboundSnap = await convRef.collection('messages')
      .where('messageId', '==', smokeId)
      .limit(1)
      .get();
    inboundSnap.docs.forEach((d) => writes.push(d.ref.set({ smokeTest: true }, { merge: true })));
    const outboundSnap = await convRef.collection('messages')
      .where('direction', '==', 'outbound')
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();
    outboundSnap.docs.forEach((d) => {
      const ms = d.data().timestamp?.toMillis?.() || 0;
      if (ms > beforeMs) writes.push(d.ref.set({ smokeTest: true }, { merge: true }));
    });
    await Promise.all(writes);
  } catch (e: any) {
    console.error('[smokeTest] failed to flag scenario traffic:', e?.message || e);
  }

  const after = await convRef.collection('messages')
    .where('direction', '==', 'outbound')
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();
  const msg = after.docs[0]?.data() || ({} as any);
  const reply: string = msg.body || '';
  const replyMs = msg.timestamp?.toMillis?.() || 0;

  const checks: Record<string, { pass: boolean; detail?: string }> = {};

  checks.replied = {
    pass: !!(reply && replyMs > beforeMs && Date.now() - t0 < 5 * 60 * 1000),
    detail: reply ? undefined : 'no outbound message stored for this run',
  };
  checks.aiGenerated = {
    pass: (msg.tokensIn || 0) > 0,
    detail: `tokensIn=${msg.tokensIn ?? 'missing'} (canned fallback has none)`,
  };
  const detected = reply ? detectMessageLanguage(reply, scenario.expectedLang) : scenario.expectedLang;
  checks.language = {
    pass: detected === scenario.expectedLang,
    detail: `expected ${scenario.expectedLang}, detected ${detected}`,
  };
  checks.noPortalLink = {
    pass: !reply.includes('/portal/'),
    detail: reply.includes('/portal/') ? 'reply contains a portal link' : undefined,
  };
  const cannedHit = CANNED_MARKERS.find((m) => reply.includes(m));
  checks.notCanned = {
    pass: !cannedHit,
    detail: cannedHit ? `canned fallback text leaked: "${cannedHit}"` : undefined,
  };

  const pass = Object.values(checks).every((c) => c.pass);
  return { name: scenario.name, pass, reply: reply.slice(0, 500), checks };
}

async function runSmokeTest(): Promise<void> {
  const cfg = await readConfig();
  if (!cfg.enabled) {
    console.log('[smokeTest] disabled via config/smokeTest - skipping');
    return;
  }
  console.log(`[smokeTest] running ${SCENARIOS.length} scenarios against ${cfg.businessPhone}`);

  // Resolve the account that currently owns the smoke number BEFORE anything
  // else - the same findBusinessByPhone lookup processIncomingMessage uses.
  // A WhatsApp number can be disconnected and reconnected under a different
  // account (this happened 2026-09-14..16); asserting against a hardcoded
  // professional then reports the bot as broken when it replied fine under
  // the new owner.
  const business = await findBusinessByPhone(cfg.businessPhone);
  const professionalId = cfg.professionalId || business?.professionalId || null;
  if (!professionalId) {
    console.error(`[smokeTest] no professional owns WhatsApp number ${cfg.businessPhone} - reporting routing failure`);
  } else if (business) {
    console.log(`[smokeTest] business phone ${cfg.businessPhone} is owned by professional ${business.professionalId}`);
  }
  const runCfg = { ...cfg, professionalId };

  const results: ScenarioResult[] = [];

  if (!professionalId) {
    results.push({
      name: 'routing',
      pass: false,
      reply: '',
      checks: {
        business: {
          pass: false,
          detail: `no professional owns WhatsApp number ${cfg.businessPhone} - was it disconnected, or reconnected under a different account?`,
        },
      },
    });
  } else {
    // Announce the run to the test phone BEFORE firing anything, and store the
    // notice (flagged smokeTest) so the bot's history filters it out too.
    try {
      const notice =
        `🤖 Automated bot test: I'm about to send ${SCENARIOS.length} test messages ` +
        `(2 in English, 2 in Spanish) to check the bot is working. ` +
        `These are not from a customer - you can ignore the replies.`;
      // Same defensive decrypt as sendReply: newer businesses store the token
      // encrypted, older ones plaintext - only decrypt when it looks encrypted.
      let token = business?.accessToken || '';
      if (token.includes(':') && /^[A-Za-z0-9+/=_-]+:[A-Za-z0-9+/=_-]+(:[A-Za-z0-9+/=_-]+)?$/.test(token)) {
        token = decrypt(token);
      }
      const sent = business
        ? await sendWhatsAppMessage(cfg.testCustomerPhone, notice, business.phoneNumberId, token)
        : null;
      console.log('[smokeTest] announcement sent:', sent?.messageId || 'ok');
      await db
        .collection('professionals')
        .doc(professionalId)
        .collection('conversations')
        .doc(cfg.testCustomerPhone)
        .collection('messages')
        .add({
          direction: 'outbound',
          from: cfg.businessPhone,
          to: cfg.testCustomerPhone,
          body: notice,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          read: true,
          source: 'smoke_test',
          smokeTest: true,
        });
    } catch (e: any) {
      // Non-fatal: the run itself must proceed even if the notice failed to send.
      console.error('[smokeTest] announcement failed (continuing):', e?.message || e);
    }

    // Reset the test conversation's bot-control state before driving the real
    // pipeline. The smoke customer is the owner's own phone, and manual tests
    // on it ("talk to a human" handoffs, pauses, staff replies to it) leave
    // flags that make aiProcessor skip every scenario - the monitor then fails
    // identically every day while the log only says "Handoff pending - bot
    // skipping". That is exactly what silenced 2026-09-21..28: a handoff
    // requested manually on 09-20 was never resolved, and every scenario
    // failed with replied:false. Resetting here keeps the test independent of
    // whatever manual testing happened on the number since the last run.
    try {
      const smokeConvRef = db
        .collection('professionals')
        .doc(professionalId)
        .collection('conversations')
        .doc(cfg.testCustomerPhone);
      const smokeConv = await smokeConvRef.get();
      const smokeConvData = smokeConv.data() || {};
      if (smokeConvData.handoffPending === true || smokeConvData.botPaused === true) {
        console.log(
          `[smokeTest] resetting test conversation state (handoffPending=${smokeConvData.handoffPending}, botPaused=${smokeConvData.botPaused}) left over from manual testing`
        );
      }
      // Unconditional write (mirrors lib/botResume.ts): also clears the human
      // takeover cooldown so a recent manual reply to the test phone cannot
      // make scenarios skip via "staff replied Xm ago".
      await smokeConvRef.set(
        {
          handoffPending: false,
          handoffResolvedAt: admin.firestore.FieldValue.serverTimestamp(),
          botPaused: false,
          lastStaffReplyAt: admin.firestore.FieldValue.delete(),
        },
        { merge: true }
      );
    } catch (e: any) {
      console.error('[smokeTest] failed to reset test conversation state:', e?.message || e);
    }

    for (const scenario of SCENARIOS) {
      try {
        const r = await runScenario(scenario, runCfg);
        results.push(r);
        console.log(`[smokeTest] ${scenario.name}: ${r.pass ? 'PASS' : 'FAIL'}${r.pass ? '' : ` - ${JSON.stringify(r.checks)}`}`);
      } catch (e: any) {
        results.push({
          name: scenario.name,
          pass: false,
          reply: '',
          checks: { threw: { pass: false, detail: e?.message || String(e) } },
        });
        console.error(`[smokeTest] ${scenario.name} threw:`, e?.message || e);
      }
      // Small breather between scenarios so we never look like a message flood.
      await new Promise((res) => setTimeout(res, 3000));
    }

    // The scenarios drive the real pipeline, so every run bumps the
    // conversation doc like genuine traffic: lastMessage/lastMessageAt jump
    // to canned test text (pushing this thread to the top of the owner's
    // inbox every morning and burying the last real customer exchange) and
    // unreadCount creeps up by 4 a day. Restore the preview to the newest
    // NON-smoke message after the run; the flagged messages stay in history
    // and the run evidence lives in smokeTests.
    try {
      const convRef = db
        .collection('professionals')
        .doc(professionalId)
        .collection('conversations')
        .doc(cfg.testCustomerPhone);
      const runStart = Date.now() - 60_000; // serverTimestamp vs Date.now() drift allowance
      const recent = await convRef.collection('messages').orderBy('timestamp', 'desc').limit(120).get();
      const msgs = recent.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
      const lastReal = msgs.find((m) => !m.smokeTest && m.body);
      const smokeInbounds = msgs.filter(
        (m) => m.smokeTest && m.direction === 'inbound' && (m.timestamp?.toMillis?.() ?? 0) > runStart
      ).length;
      if (lastReal) {
        await convRef.set(
          {
            lastMessage: lastReal.body,
            lastMessageAt: lastReal.timestamp,
            ...(smokeInbounds ? { unreadCount: admin.firestore.FieldValue.increment(-smokeInbounds) } : {}),
          },
          { merge: true }
        );
        console.log(
          `[smokeTest] restored conversation preview to last real message (${smokeInbounds} smoke inbounds un-counted)`
        );
      }
    } catch (e: any) {
      console.error('[smokeTest] failed to restore conversation preview:', e?.message || e);
    }
  }

  const allPass = results.every((r) => r.pass);
  // Results live under the professional that owns the number; the routing
  // failure case has no owner, so keep the doc in the historical home.
  const resultsHomeId = professionalId || DEFAULT_CONFIG.resultsHomeProfessionalId;

  try {
    // Strip undefined values - Firestore rejects them and the checks only
    // populate `detail` on failures.
    const sanitized = JSON.parse(
      JSON.stringify({ runAt: new Date().toISOString(), pass: allPass, professionalId, scenarios: results })
    );
    await db.collection('professionals').doc(resultsHomeId).collection('smokeTests').add(sanitized);
  } catch (e: any) {
    console.error('[smokeTest] failed to write results doc:', e?.message || e);
  }

  console.log(JSON.stringify({ event: 'bot_smoke_test', pass: allPass, failed: results.filter((r) => !r.pass).map((r) => r.name) }));

  if (!allPass) {
    // How many runs in a row have failed (this run's doc is already written,
    // so the count includes today). 8 consecutive identically-worded "FAILED"
    // emails went unread 2026-09-21..28; the subject now says how long the
    // break has lasted so a repeated alert reads as escalating, not spam.
    let streak = 1;
    try {
      const recent = await db
        .collection('professionals')
        .doc(resultsHomeId)
        .collection('smokeTests')
        .orderBy('runAt', 'desc')
        .limit(10)
        .get();
      streak = 0;
      for (const doc of recent.docs) {
        if (doc.data().pass === false) streak++;
        else break;
      }
    } catch (e: any) {
      console.warn('[smokeTest] could not count failure streak:', e?.message || e);
    }
    const failedRows = results
      .filter((r) => !r.pass)
      .map(
        (r) =>
          `<li><b>${r.name}</b>: ${Object.entries(r.checks)
            .filter(([, c]) => !c.pass)
            .map(([k, c]) => `${k} (${c.detail || 'failed'})`)
            .join(', ')}<br><i>reply: ${r.reply ? r.reply.replace(/</g, '&lt;').slice(0, 300) : '(none)'}</i></li>`
      )
      .join('');
    const streakNote =
      streak > 1
        ? `<p><b>This is failure #${streak} in a row.</b> If the streak keeps growing the bot is DOWN for real - investigate now: check Cloud Logging for the botSmokeTest function and aiProcessor skips.</p>`
        : '';
    try {
      await sendTransactionalEmail({
        to: cfg.alertEmail,
        subject: `🚨 Bot smoke test FAILED (${results.filter((r) => !r.pass).length}/${results.length} scenarios${streak > 1 ? `, ${streak} days in a row` : ''})`,
        htmlContent: `<p>The nightly bot smoke test failed. The customer-visible bot replies are wrong:</p><ul>${failedRows}</ul>${streakNote}<p>Number ${cfg.businessPhone} is owned by professional ${professionalId || 'UNKNOWN'}. Run details are in Firestore: professionals/${resultsHomeId}/smokeTests.</p>`,
      });
      console.log('[smokeTest] failure alert email sent to', cfg.alertEmail);
    } catch (e: any) {
      console.error('[smokeTest] failed to send alert email:', e?.message || e);
    }
  }
}

export const botSmokeTest = functions
  .runWith({ timeoutSeconds: DEFAULT_CONFIG.timeoutSeconds, memory: '512MB', secrets: [shopifyApiSecret] })
  .pubsub.schedule('43 7 * * *') // 09:43 Madrid - after the newsletter sweep
  .timeZone('Europe/Madrid')
  .onRun(async () => {
    await runSmokeTest();
    return null;
  });