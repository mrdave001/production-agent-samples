# Agent code samples

These are extracts from production systems I run today. My flagship product, [Conversify](https://conversify.app), is an AI receptionist for small businesses: it answers WhatsApp, Messenger and Instagram messages, books appointments, switches between English and Spanish per customer, and hands off to a human when it should. Its repo is private (it's a live, paying product), so this is a hand-picked set of the parts I'm proudest of, lightly scrubbed (placeholder numbers and account IDs).

Each folder has its own README with the story behind the code.

## [bot-smoke-test](./bot-smoke-test)

A scheduled agent that messages my production bot once a night, through the real message pipeline, and asserts the replies are actually good: produced at all, AI-generated (not a canned fallback), in the right language, with nothing forbidden in them. On failure it emails me with the failure streak in the subject, because I once let a broken bot email me the same "FAILED" subject eight days in a row without reading it.

Every design decision in that file comes from a real incident. The comments tell you which.

## [language-anchoring](./language-anchoring)

How the bot decides which language to reply in. The rule: the customer's first clear message sets the conversation's language, and everything after that sticks to it. Sounds trivial; it took three iterations to get right, and each iteration came out of a live customer conversation going wrong. Includes a drift guard that regenerates a reply once when the model lets heavy same-language context pull it off the anchor.

## [seller-commission](./seller-commission)

The commission accrual inside my Stripe webhook. Money code in a webhook that Stripe retries, so: idempotent by document ID, one transaction, failure-isolated so billing never breaks because of it, and hardened against the one fraud case I could think of (customers extending their own commission window client-side). The full context is in the README.

---

Why these three? Because building an agent is the easy half. The interesting work is knowing when the agent is wrong, stopping it from being confidently wrong in a customer's face, and making sure that when money moves, it moves exactly once. That's what these files are about.