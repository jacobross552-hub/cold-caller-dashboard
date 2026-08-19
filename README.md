# Cold caller dashboard

Runs and monitors the Jacob cold-calling agent without going into ElevenLabs.

- **Find leads** — search Google's business listings for the trades most likely
  to be missing calls, score them, and import the good ones
- Import leads by hand too (paste, CSV, or a JSON API endpoint)
- Start a calling run — calls only go out inside legal Australian calling hours
- A call log with plain-English summaries and the full transcript
- Booked meetings flagged, each with a pre-call briefing
- A text to your mobile the moment a meeting books
- **What it all costs** — lifetime spend broken down by source, with what's
  measured, what's estimated from a rate you set, and what isn't counted yet

---

## Getting it running on your PC

You need Node.js 22 or newer installed (`node --version` to check).

```bash
npm install
npm run dev
```

Then open **http://localhost:3000**. The password is whatever you set as
`DASHBOARD_PASSWORD` in `.env`.

**A `.env` has already been created for you** with a random `SESSION_SECRET`
and the temporary password `changeme`. Change that password before this ever
goes on the internet.

---

## The credentials it needs

Open `.env` and fill these in. Everything works without them except the parts
they power — the dashboard tells you on-screen what's switched off and why.

| What | Where to get it | What breaks without it |
|---|---|---|
| `ELEVENLABS_API_KEY` | elevenlabs.io → profile menu → API Keys | No calls can go out |
| `ELEVENLABS_AGENT_ID` | elevenlabs.io/app/agents → open your agent → the ID in the URL | No calls can go out |
| `ELEVENLABS_PHONE_NUMBER_ID` | elevenlabs.io/app/agents/phone-numbers → your Twilio number | No calls can go out |
| `ELEVENLABS_WEBHOOK_SECRET` | Shown once when you create the post-call webhook (below) | Calls go out but nothing comes back into the call log |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys | No summaries, no pre-call briefs — transcripts only |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | console.twilio.com → Keys & Credentials | No text when a meeting books |

Once they're in, check they actually work before dialling anyone:

```bash
npm run check:creds
```

That calls each service read-only — it never places a call or sends a message —
and tells you in plain English what's wrong with anything that isn't right. It
also reports whether your **Twilio account is still on trial**, which matters:
a trial account can only reach numbers you've verified, so real prospects
silently fail.

`.env` is gitignored and never leaves your machine. `.env.example` shows the
same list with no values in it.

---

## Connecting the post-call webhook

This is what puts calls into the call log.

1. In ElevenLabs, go to your workspace settings → Webhooks → create a post-call
   webhook.
2. Point it at `https://<your-address>/api/webhooks/elevenlabs`.
3. Copy the signing secret it shows you (once) into `ELEVENLABS_WEBHOOK_SECRET`.

While you're testing on your own PC, ElevenLabs can't reach `localhost`. Use
ngrok (you already have a token):

```bash
ngrok http 3000
```

Then use the `https://….ngrok-free.app/api/webhooks/elevenlabs` address it
gives you. Visiting that URL in a browser should show a small "endpoint is
live" message — that confirms ElevenLabs can reach it.

---

## Finding leads

The **Find leads** tab searches Google's business listings for the trades most
likely to be missing calls, scores each one, and drops the good ones straight
onto your leads list — ready to dial.

Pick your verticals (Tier 1 trades are ticked by default), type some suburbs,
say how many leads you want, press **Go**. It runs in the background: the page
refreshes itself while it works, and you can close it and come back.

### What it costs

Almost nothing. One search call returns up to 20 businesses complete with
phone, hours, website and review count, at **$0.035 USD**:

| Leads | Estimated |
|---|---|
| 25 | $0.15 – $0.35 AUD |
| 100 | $0.55 – $1.35 AUD |

And Google's first **1,000 searches a month are free** — around 5,800 leads —
so in practice you'll never be billed at your volume. The figures above are
what you'd pay past the allowance.

Every API call is logged to its own row with the price that applied, so a run's
cost is summed from calls that actually happened, not estimated afterwards. Past
runs keep their real cost even after Google changes its prices.

> **One thing to know if you go reading Google's docs.** Places API (New) bills
> the whole call at the highest tier in your field mask, and `rating` /
> `userRatingCount` are Enterprise-tier — the same as the phone number. So the
> usual advice to "filter on cheap fields first, then pay for contact details"
> saves nothing here. We ask for everything in one call instead. Any figure
> quoting "$0.017 base + $0.003 contact data" is the *legacy* API.

Two caps stop a mis-click getting expensive: `MAX_LEADS_PER_RUN` (200) and
`MAX_COST_PER_RUN_AUD` (25). The cost cap is checked before the run starts
*and* again before every single API call.

### How a lead gets picked

Scored 0–100 on the missed-call research: tier of trade, review count as a
proxy for call volume, whether they shut in the evening or at weekends, whether
they look independent rather than a chain, and whether there's a real phone
number. Hover the ICP badge on the leads list to see the reasons.

A business advertising 24/7 cover or an answering service scores near zero —
they've already bought what you're selling.

### The rules it will not break

- **Nothing is scraped.** It uses the official Places API. Scraping Google
  breaches their terms and risks the account.
- **Business numbers only.** A mobile is imported only when something proves a
  business behind it — an active ABN, a website, or a business category on the
  listing. For a sole-trader sparky the mobile *is* the business line, so a
  blanket ban would throw away the best prospects; an uncorroborated mobile
  might be someone's personal phone, so that one is refused.
- **Every lead carries its provenance** — which search found it, when, the
  Google place id, and why the number is lawful to ring. Stored on the lead.
- **Opt-outs are permanent.** Anyone who asks to be removed goes on the
  `do_not_contact` list, which is checked *at import*, not just at call time.
  A number on it can never be sourced back onto the list by a later run. That
  list is never emptied by the app, and restoring a lead deliberately does not
  clear it.
- **Calling hours still apply** to every lead this finds — see below.

The **Leads** page has the do-not-contact list on it: add a number by hand when
someone rings back and asks to be removed, see everything that's on there, and
take one off if it was added by mistake.

```bash
npm test
```

Seven suites: calling hours, lead scoring, the import guardrails, calendar
bookings, cost accounting, a full lead run end-to-end against a fake source,
and an integration pass across both halves of the system. The lead run
exercises pagination, dedup, suppression, the cost ledger and the cost cap with
no API key and no spend. All of them use a throwaway database, never your real
one.

### Set-up

`GOOGLE_PLACES_API_KEY` needs a Google Cloud project with **Places API (New)**
enabled and billing switched on — billing must be on even though you'll stay
inside the free allowance, or every call returns 403.

`ABN_LOOKUP_GUID` is free and instant from
[abr.business.gov.au](https://abr.business.gov.au/Tools/WebServices). Optional,
but without it fewer sole-trader mobiles pass the guard above.

> **Public holidays are checked against NSW only.** Leads are dialled in their
> own state's time, but the holiday table is NSW's. A Victorian lead is blocked
> on a NSW-only holiday and allowed on a Victorian-only one such as Melbourne
> Cup Day. Fine for a NSW list; worth fixing before sourcing interstate at
> volume. The dashboard says so on the Find leads page.

---

## The calling-hours guard

Calls are only dispatched **Mon–Fri 9am–8pm, Sat 9am–5pm, never Sunday, never
a NSW public holiday** — worked out in **each lead's own state's time**, falling
back to Sydney when the state is blank or unrecognised. Sydney 9am is 7am in
Perth, so a WA lead waits until 11am Sydney time and stays callable until 10pm.

Those hours apply even though you're calling businesses. The B2B exemption only
lifts the Do Not Call Register's "you may not ring this number at all" — it does
not touch the calling-hours rule, which binds separately. The full reasoning,
with the regulator's wording, is in the header of `src/lib/calling-hours.ts`,
so nobody widens the window by accident.

This is enforced in the dialling layer, not in the agent's prompt — pressing
"start calling" never dials anything directly. It queues the run, and a check
that runs every minute releases calls only when the window is open. So:

- Queue 20 calls at 9pm and they sit until 9am the next morning.
- A run still going at 8pm stops and picks up where it left off next morning.
- Every hold is written to the activity log with its reason.

There is also a daily cap (`MAX_CALLS_PER_DAY`, default **250**, raised from
20 on 18 Aug 2026). It is a throughput and cost guard, not a legal one — no
ACMA instrument caps calls per day. The number that matters at this volume is
in `plan.md`'s risk table: carrier spam-flagging is "not a real problem under
20 calls/day" but "becomes the dominant problem above ~200/day". If answer
rates fall away on the Twilio number, look here first.

At `DISPATCH_CHUNK_SIZE=5` the scheduler dials in chunks of five and waits for
each batch to finish before starting the next, so 250 calls is a full day of
steady dialling rather than a burst. Raise the chunk size if it is not keeping
up. Note also that `MAX_LEADS_PER_RUN` is 200, so one lead run no longer fills
a whole day at this cap.

Run the tests on this any time:

```bash
npm run test:hours
```

39 cases, covering the window edges, Sundays, both daylight-saving switches,
and the multi-day holiday blocks (Christmas 2026 correctly skips to Tuesday
29 December; Anzac Day 2026 skips to Tuesday 28 April).

**The public-holiday list runs out at the end of 2027.** The dashboard warns
you 60 days before that. Top it up in `src/lib/holidays.ts` from
nsw.gov.au/about-nsw/public-holidays.

`ALLOW_OUTSIDE_CALLING_HOURS=true` bypasses the guard — only for testing
against your own mobile. When it's on, the dashboard says so in red.

---

## Where the numbers come from

Nothing about pricing is invented. `src/lib/pricing.ts` holds the seven-band
table copied from `pricing-engine-notes.md` §4, which matches
`knowledge-base-objections.md` and the PRICING section of
`system-prompt-v8.txt` — all three were checked against each other.

If you change your pricing, change it in those files first, then in
`src/lib/pricing.ts`.

The briefing also **checks the price the agent actually quoted against that
table** and flags it in red if it quoted off-table. `system-prompt-v8.txt`
makes that a hard rule, and an unsupervised agent inventing a number is
exactly what you'd want to know before walking into the demo.

---

## How a lead can never be called twice, or after opting out

The lead finder and the dialler are one system sharing one `leads` table, so
there is a single place a lead can exist and a single place it can be
suppressed.

**Duplicates** are stopped at import, and every route in — the finder, CSV,
paste, the JSON API — goes through the same function. A lead is rejected if
its phone number already exists, or if its Google place id does (which catches
the same business listed again under a new number).

**Opt-outs** are checked in three overlapping places, on purpose:

1. **At import** — a suppressed number can never get onto the leads table.
2. **When a run is queued** — suppressed leads aren't selected.
3. **Immediately before each batch is dialled** — because a run spans days
   once the calling-hours guard pauses it overnight, and someone can opt out
   between being queued and their turn coming round.

Layers 2 and 3 aren't redundant: layer 1 only ever sees numbers suppressed
*before* import. Adding a number to the do-not-contact list also marks any
existing lead row `do_not_call`, so the two never disagree.

Anyone who asks to be removed **on a call** is added to the permanent list
automatically, so a later lead run can't source them back in.

---

## Going live (Railway, about $5–10/month)

Your PC works for testing, but calls that end while it's asleep are lost.
For real use it needs to be always-on.

1. Make a GitHub repo from this folder and push it.
2. Sign up at railway.app, "New Project" → "Deploy from GitHub repo".
3. Add every variable from your `.env` in Railway's Variables tab.
4. Add a Volume mounted at `/data`, and set `DATABASE_PATH=/data/dashboard.db`
   so your call history survives redeploys.
5. Update the ElevenLabs webhook to the Railway address.

Railway sets `PORT` itself and `npm start` respects it — no change needed.
The database builds itself on first boot, so an empty volume is fine.

---

## If the dashboard suddenly returns errors on every page

Almost always this: **`npm run build` was run while `npm run dev` was still
running.** They both write to `.next`, and the dev server's manifest gets
clobbered. The tunnel stays up, so from outside it looks fine while every
request 500s — and a webhook arriving in that window is lost.

Fix: stop both, `rm -rf .next`, start again.

---

## What this deliberately doesn't do

- **It doesn't manage clients you've sold to.** That's phase two. The database
  is structured so it can be added without a rewrite.
- **It doesn't change the agent.** The script, prompt and voice stay in
  ElevenLabs. This dashboard reads and dials; it never edits the agent.
- **It doesn't store call audio**, matching the "transcripts only" decision in
  `plan.md`.

---

## Cost

The **Costs** tab shows what the whole system has cost since day one, broken
down by where the money went, with per-call and per-meeting figures underneath.

### Every figure says where it came from

This is the part worth understanding, because the three kinds of number on that
page are not equally trustworthy and the page never blends them silently:

| Label | What it means |
|---|---|
| **Measured** | Summed from per-event figures the provider itself reported, one row per event, with the price that applied stored alongside. Auditable months later; unaffected by a later price change. |
| **Rated** | The usage is real and recorded — texts actually sent, minutes actually talked — but the price is a rate from your `.env`, not a figure anyone billed you. |
| **Configured** | A flat monthly subscription the dashboard cannot see. Whatever you typed in, times the months the system has been running. |

Anything that can't be measured and hasn't been configured shows as **"not
set"**, not as `$0`, and the lifetime total is labelled a floor rather than a
total until you fill the gaps in. A missing number and a genuinely free line
item are different things.

### What's measured

- **ElevenLabs** — split into voice/telephony and the agent's own LLM, both in
  real dollars, straight from each call's post-call webhook.
- **Google Places** — from the per-call ledger the lead finder already keeps,
  at the exchange rate that applied on the day of the run.
- **ABN Lookup** — free, but the call count is logged so it's auditable.
- **Anthropic** — the dashboard's own spend on summaries and briefings, priced
  from the tokens the API reported and frozen on the row.

> **A trap worth knowing about.** The `cost` field on ElevenLabs' post-call
> webhook is **credits, not money** — a 157-second call reports `2092`. The
> real money is `cost_fiat`, and `charging` splits it into voice and LLM. The
> dashboard was storing only the credits figure; summing that column as dollars
> would have claimed thousands of dollars of spend on three test calls. Calls
> recorded before this landed are re-priced automatically on first boot, out of
> the webhook payload already stored on each row — nothing is fetched and
> nothing is estimated.

### What you have to tell it

Four things the dashboard has no visibility into. Until they're set, they're
excluded from the total and the page says so:

| Variable | What it's for |
|---|---|
| `TWILIO_SMS_COST_USD` | Per SMS segment. |
| `TWILIO_CALL_COST_USD_PER_MIN` | **Per outbound call minute — the big one.** |
| `ELEVENLABS_PLAN_MONTHLY_AUD` | Your ElevenLabs plan fee. |
| `RAILWAY_MONTHLY_AUD` | Hosting. |

Read the two Twilio figures off your own console rather than a public rate
card — AU pricing is account- and destination-specific.

> **Twilio bills you twice over, and it's easy to miss.** ElevenLabs dials
> through *your* Twilio number, so Twilio charges for the call minutes on top
> of what ElevenLabs charges for the call. At 20 calls/day that's noise. At the
> current cap of 250 it is not: roughly 650 minutes a day. That spend is
> invisible to the dashboard until `TWILIO_CALL_COST_USD_PER_MIN` is set.

There are also **two separate LLM bills**, which the page keeps as separate
lines: the voice agent's own model is billed by ElevenLabs, while the
dashboard's `ANTHROPIC_API_KEY` pays for something different — the call
summaries and pre-call briefings. Roughly a cent or two per real conversation,
and nothing at all for voicemails and no-answers, which skip the model
entirely. It defaults to Claude Opus 5; set `ANTHROPIC_MODEL=claude-sonnet-5`
in `.env` if you'd rather trade a little quality for lower cost.

Anthropic's rates live in `src/lib/costs.ts` and nowhere else. If they change,
change them there — rows already written keep the cost they were priced at.

```bash
npm run test:costs
```

41 cases, most of them about the honesty rules rather than the arithmetic:
that credits are never read as money, that an unpriced line stays unpriced
instead of becoming zero, and that a total which omits something says so.
