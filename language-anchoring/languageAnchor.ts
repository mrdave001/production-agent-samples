/**
 * EXTRACT from the AI reply pipeline (aiProcessor.ts). Not standalone: the
 * surrounding code (message history, the Gemini call, conversation doc
 * handles) is the private product's; these two blocks are the language
 * policy, verbatim. Read together with messageLanguage.ts in this folder.
 */

// ─────────────────────────────────────────────────────────────────────────
// Block 1: the language anchor — run before the AI call.
//
// An ambiguous short reply ("Yes", "Ok", "Sorry") gets NO hard anchor:
// fall back to the language of the customer's own recent turns, then to
// the language they last used with confidence in this conversation
// (persisted on the conversation doc), and only then to the business
// default. The customer's initial-contact language — not the business
// preset — defines the conversation: "hi"/"hello" in, English out;
// "hola, can you confirm what time you close today?" reads English by
// word count, so English it is.
// ─────────────────────────────────────────────────────────────────────────

let anchorSource: 'message' | 'history' | 'default' = 'default';
let anchorLang = detectMessageLanguageStrict(messageText);
if (anchorLang) {
  anchorSource = 'message';
  // Remember the customer's language on the conversation so short/ambiguous
  // replies ("ok", "yes", "sí") later - even after the history window has
  // moved on - still resolve to it instead of the business preset. Only
  // written when the conversation doc already exists; new conversations get
  // this field on their second turn (the first turn is anchored anyway).
  // Fire-and-forget: a failed write must never block the reply.
  if (earlyConvSnap?.exists) {
    conversationRef
      .update({ customerLanguage: anchorLang })
      .catch(() => {});
  }
} else {
  const recentCustomerText = history
    .filter(m => m.role === 'user')
    .slice(-5)
    .map(m => m.content)
    .join(' ');
  const historyLang = detectMessageLanguageStrict(recentCustomerText);
  if (historyLang) {
    anchorLang = historyLang;
    anchorSource = 'history';
  } else if (
    earlyConvData?.customerLanguage === 'es' ||
    earlyConvData?.customerLanguage === 'en'
  ) {
    // No confident detection in this message or recent turns - but the
    // customer's earlier clear messages set the conversation's language.
    anchorLang = earlyConvData.customerLanguage;
    anchorSource = 'history';
  }
}

// ...the Gemini call happens here with `anchorLang` in the prompt...

// ─────────────────────────────────────────────────────────────────────────
// Block 2: the drift guard — run on the AI's reply, before sending.
//
// The anchor pins the reply language on confident detections, but heavy
// same-language context in the prompt (Spanish catalog + config for an
// English customer, or the reverse) can still pull the model off it. When
// the anchor came from the customer's own message and the reply confidently
// reads as the other language, regenerate once with an explicit instruction.
// Ambiguous replies (short, mixed, "Sí, claro") never trigger a retry.
// ─────────────────────────────────────────────────────────────────────────

const anchorLangName = anchorLang === 'es' ? 'español' : 'English';
if (
  anchorSource === 'message' &&
  anchorLang &&
  detectMessageLanguageStrict(aiResponse) &&
  detectMessageLanguageStrict(aiResponse) !== anchorLang
) {
  console.log(`🌐 [AI] Reply language drift: customer wrote ${anchorLangName}, reply came back ${detectMessageLanguageStrict(aiResponse) === 'es' ? 'español' : 'English'} - regenerating once`);
  const langRetry = await generateGeminiResponse(
    systemPrompt +
    `\nCRITICAL: the customer wrote in ${anchorLangName}. Your ENTIRE reply must be written in ${anchorLangName} - every sentence, product name aside, no exceptions.\n`,
    history,
    messageText,
    false,
    anchorLang,
    { professionalId, planTier }
  );
  if (langRetry.text) {
    aiResponse = langRetry.text;
    console.log(`🌐 [AI] Language retry succeeded (${anchorLangName})`);
  }
}