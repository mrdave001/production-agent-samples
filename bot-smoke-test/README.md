# Bot smoke test

## The problem

Every regression my bot ever shipped was found by me, manually messaging it. Spanish replies to English messages. A HIPAA portal link on "hi, how are you". AI failures silently falling back to canned text, which looks like a reply and therefore fools everyone.

Manual testing doesn't scale and isn't honest — you test the thing you just fixed, not the thing you broke last month. So I automated myself out of the loop: a scheduled function that does what I used to do, once a night, and actually reads the answers.

## What it does

It drives the **real** message pipeline (`processIncomingMessage`, not a mock) with four canned scenarios (2 English, 2 Spanish — greetings and pricing, deliberately no booking scenario, so the test can never create a real appointment). Then it asserts on what the bot actually stored:

1. A reply was produced at all
2. The AI actually generated it (`tokensIn > 0` — a canned fallback has no tokens)
3. The reply language matches the message language
4. No portal link was sent
5. No known canned-fallback phrasing leaked out

On any failure it emails me, and the subject says how many days in a row the test has failed. Successful runs stay silent.

## Why the file is shaped the way it is

Each odd-looking block is an incident:

- **Test traffic is flagged `smokeTest: true`** and the AI's history loaders skip flagged messages. Without this, every nightly run taught the bot four nonsense exchanges and polluted its context for real customers.
- **The conversation preview gets restored after the run.** The scenarios bump the thread's `lastMessage` and `unreadCount` like real traffic, which pushed the test conversation to the top of the owner's inbox every morning and buried the last real customer exchange.
- **The bot-control state gets reset before driving the pipeline.** I once manually tested "talk to a human" handoffs on the test number, never resolved the handoff, and the monitor then failed identically every day for a week while the log just said "Handoff pending - bot skipping." The test now starts from a clean slate regardless of what manual testing happened on that number.
- **The business phone is resolved to its current owner at run time** (the same lookup the real pipeline uses). A WhatsApp number can be disconnected and reconnected under a different account; asserting against a hardcoded account ID reports the bot as broken when it replied fine under the new owner.
- **The failure email counts the streak.** Eight consecutive identically-worded "FAILED" emails went unread. A subject that escalates ("day 6 in a row") gets read.

## How to read it

The file is TypeScript for Firebase Cloud Functions (Gen 1), with the surrounding product's helpers imported (`./lib/aiProcessor`, `./lib/whatsapp`, etc.). It won't compile standalone — it's an extract, kept verbatim except for placeholder phone numbers, email, and account IDs.