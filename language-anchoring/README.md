# Language anchoring

## The problem

A bilingual bot has to pick one language per reply, and get it right every time, in a product where the business owner can set a default language but the customer can't set anything. My product serves English and Spanish-speaking customers of the same business, sometimes in the same day.

The failure mode that started this: reply language was inferred from the customer's phone country code and the business's setting, never from what the customer actually wrote. A customer on a Spanish number who wrote in English still got Spanish. Annoying in a demo; fatal when it's a real customer's first message.

## The policy

The customer's initial-contact language defines the conversation. Not the business preset:

- **Confident detection wins.** "Hi" or "hello" in means English out. "Hola, can you confirm what time you close today?" reads English by word count, so English it is.
- **The first confident detection is sticky.** It's persisted on the conversation doc, so a later ambiguous "ok" or "sí" - even after the history window has moved on - resolves to the language the customer actually speaks, not the business default.
- **Ambiguous messages never guess.** "Yes", "Ok", "Sorry" score nothing (see `detectMessageLanguageStrict` returning null). The fallback chain is: this message, then the customer's own recent turns, then the persisted language, and only then the business default.
- **A wrong sticky write must never block a reply.** The persistence is fire-and-forget.

## The drift guard

Anchoring the prompt isn't enough on its own. When a Spanish-configured business has an English customer, the prompt context is mostly Spanish - catalog, config, canned text - and the model gets dragged along by it even with an English instruction in the prompt.

So the pipeline checks the model's output the same way it checks the customer's input, with the same confident-only detector. When the anchor came from the customer's own message and the reply confidently reads as the other language, it regenerates once with an explicit instruction. Ambiguous replies never trigger a retry - a short "Sí, claro" must not cost the customer a second round-trip.

## Files

- `messageLanguage.ts` — the detector, verbatim and standalone. Deliberately not an ML model: word-boundary stopword scoring, confident-only, ~75 lines, zero latency, zero cost, and debuggable by reading it.
- `languageAnchor.ts` — the two pipeline blocks (anchor + drift guard), extracted from the reply pipeline with the surrounding product code elided.