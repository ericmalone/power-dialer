# Setup guide

Written so you can do this yourself. Budget about 20 minutes the first time.
Nothing here requires you to write code.

You need exactly **two values** from Twilio. The dialer does the rest of the
Twilio wiring itself, on every boot — it creates its own API key and TwiML
app, adopts your numbers as caller IDs, and points Twilio's webhooks back at
whatever address it is currently running on.

---

## What you need before you start

| Thing | Why | Cost |
|---|---|---|
| A Twilio account, **upgraded** (not trial) | Trial accounts can only call numbers you have personally verified | Pay as you go |
| At least one phone number bought in Twilio | This is the number your leads see on caller ID | ~$1.15/mo each |
| A Render.com account | Where the dialer lives so Twilio can reach it | ~$7/mo |
| A USB headset per employee | Browser dialing needs a mic | $25-60 each |
| Chrome or Edge on each employee's computer | Safari and Firefox are flakier with browser calling | Free |

---

## Step 1 - Collect two values from Twilio

Open <https://console.twilio.com>.

**1a. Account SID and Auth Token**
Right on the console home page under "Account Info". Copy both. That is
everything you need to collect.

Treat the auth token like the password to your bank. It can place calls, send
texts, spend your balance and read every recording on the account. It goes in
one place only — your hosting provider's Environment tab — and nowhere else:
not in a file, not in a repository, not in a message to anybody. If it ever
travels through email or chat, go to **Account → API keys & tokens → Auth
tokens** and rotate it.

**1b. Buy a phone number** (if you have not already)
**Phone Numbers** → **Buy a number** → pick a local number with **Voice**
capability. Buy one number per 3-5 agents to start; more numbers spread your
call volume and help your calls keep connecting.

### What you are *not* doing

You do not create an API key. You do not create a TwiML App. You do not paste
webhook URLs onto your numbers. On first boot the dialer signs in to your
Twilio account with the two values above and does all of it, then re-checks it
every time it restarts — which is what stops the classic failure where a
redeploy moves the web address and every agent connects to silence.

If you would rather do it by hand, set `AUTO_SETUP=false` and fill in
`TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` and `TWILIO_TWIML_APP_SID`
yourself. Any value you set by hand always wins over auto-setup.

### If this Twilio account already runs something else

Read this before you go any further. Two things need care.

**Rotating the auth token will break the other application** if that
application authenticates with the auth token. Twilio's rotation is designed
for exactly this, and both tokens are live at once, so do it in this order:

1. **Account → API keys & tokens → Request a secondary token.** Both the old
   primary and the new secondary now work.
2. **Put the secondary token into every application on this account** — the
   dialer, and whatever else you run. Confirm each one still works.
3. **Only then click Promote to primary.** The old token dies the instant you
   do. Nothing should still be using it.

If the other application authenticates with an **API key** (a credential
starting `SK`, not the auth token), rotating the auth token does not affect it
at all. API keys are separate credentials with their own secrets.

**Tell the dialer which numbers are its own.** Left to itself, auto-setup
claims every voice-capable number on the account as a caller ID and points
every SMS-capable number's inbound webhook at itself. On a shared account that
is not what you want. So set:

```
TWILIO_SHARED_ACCOUNT=true
CALLER_IDS=+12125551234,+12125551235
```

With that on, auto-setup treats `CALLER_IDS` as the complete list of numbers it
may read or write, and refuses to run the number steps at all if the list is
empty rather than guessing. Every other number on the account is left exactly
as it is. You can see what it did, line by line, under **Admin → System →
Twilio setup**.

The API key and TwiML App steps are safe on a shared account either way — they
only ever *create* new resources. They never modify or delete an existing key
or app, and both get your company name in their title so whoever else works in
that console can tell them apart.

### The cleaner answer: a subaccount

If you expect to keep both projects running, spend ten minutes making a Twilio
**subaccount** for the dialer instead.

A subaccount has its **own Account SID and its own auth token**. Move the
dialer's phone numbers into it, then give the dialer the *subaccount's*
credentials. From that point the two projects cannot touch each other at all:
separate numbers, separate calls, separate messages, separate recordings,
separate credentials to rotate. Usage still rolls up to one bill on the parent
account, so nothing changes about how you pay.

Twilio console → **Account → Subaccounts → Create new subaccount**. Then
**Phone Numbers → Manage → Active numbers**, open each number the dialer should
own, and change its account to the subaccount.

With a subaccount you can leave `TWILIO_SHARED_ACCOUNT=false` and skip
`CALLER_IDS` entirely — there is nothing else in there to protect.

---

## Step 2 - Put the dialer online

### Option A — Render (recommended)

1. Put this folder in a GitHub repository (private is fine).
2. Go to <https://dashboard.render.com> → **New** → **Blueprint**.
3. Point it at your repo. Render reads `render.yaml` and offers to create a
   web service called `power-dialer`. Accept.
4. It will ask you to fill in the environment variables it cannot guess:

   | Variable | Value |
   |---|---|
   | `TWILIO_ACCOUNT_SID` | from step 1a |
   | `TWILIO_AUTH_TOKEN` | from step 1a |
   | `PUBLIC_URL` | leave blank for now |
   | `ADMIN_EMAIL` | your email |
   | `ADMIN_PASSWORD` | pick a strong one |

   `deploy/render-env.txt` in this folder is the whole block, already filled
   in apart from those. Paste it into Render's **Add from .env** box.

5. Deploy. When it finishes, Render shows you a URL like
   `https://power-dialer-xxxx.onrender.com`.
6. Go back into the service's **Environment** tab, set `PUBLIC_URL` to that
   exact URL (no trailing slash), and save. It redeploys automatically — and
   on that boot it wires Twilio up to that address.

> **Do not use Render's free plan.** Free services go to sleep and hang up on
> live calls.

### Option B — your own server

```bash
cp .env.example .env      # fill in the values from Step 1
npm install
npm start
```

It listens on port 3000. Put it behind HTTPS (Caddy, nginx + certbot, or
Cloudflare Tunnel) and set `PUBLIC_URL` to the https address.

---

## Step 3 - Confirm Twilio got wired up

This step is usually already done for you. The boot that followed you setting
`PUBLIC_URL` created the API key and TwiML App, pointed the TwiML App's Voice
URL at `https://YOUR-APP-URL/twiml/agent-leg` (POST), adopted every number you
own as a caller ID, and set each SMS-capable number's "A message comes in" to
`https://YOUR-APP-URL/twiml/sms-inbound` (POST) so replies and STOP requests
come back.

To see it: sign in and go to **Admin → System** → **Twilio setup**. It shows
what the last run did, line by line. The **Run Twilio setup** button repeats
it any time — press it after you change your web address, move to a custom
domain, or buy new numbers.

Two things it deliberately will not do:

- It never overwrites a webhook URL that belongs to some other application.
  If it finds one, it says so and leaves it alone.
- It only manages numbers on the Twilio account whose credentials you gave it.

*(Optional)* If you want people to be able to call your numbers back, open each
number under **Phone Numbers → Manage → Active numbers** and set
**A call comes in** to Webhook → `https://YOUR-APP-URL/twiml/inbound` (POST).
Then set a forwarding number in **Admin → Settings**. Inbound *voice* is the
one piece still wired by hand, because most shops want those calls going
somewhere else entirely.

---

## Step 4 - First run

1. Open `https://YOUR-APP-URL` and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
2. **System** tab → **Run the check**. It calls Twilio for real and tells you
   exactly what is still wrong, with the fix written out. Do not move on until
   it is green. If something is red, press **Run Twilio setup** above it and
   check again.
3. **People** tab → add each employee. They get an email address and a
   temporary password from you; they can change it later.
4. **Call lists** tab → drop in a CSV or Excel file. The app shows you which
   columns it found, you confirm the phone column, tick the employees who
   should work the list, and import. `sample_leads.csv` in this folder is a
   working example.
5. **Do Not Call** tab → paste or upload any numbers you must never dial.
   Do this *before* your first list import so they get filtered out.

---

## Step 5 - What your employees do

They open `https://YOUR-APP-URL`, sign in, and see one screen.

1. Pick the call list.
2. Pick how many lines (start at 2).
3. Press the big green **START DIALING**.
   The browser asks for microphone permission the first time — allow it.
4. The dialer calls several numbers at once. The first real person to answer
   is in their headset instantly. Everyone else on that batch is dropped
   before it rings out.
5. When the call ends, disposition buttons appear. One click files the result
   and the next batch starts automatically.
6. **PAUSE / BREAK** stops new calls immediately and keeps their phone
   connected. **RESUME** picks straight back up. **END SESSION** finishes.

Keyboard: `Space` pauses and resumes, number keys pick a disposition,
`Esc` hangs up the current call.

---

## Step 6 - Turn on texting

Texting is built in and on by default, but US carriers will silently drop
business texts sent from an unregistered number. Do this properly once and it
just works from then on.

### 6a. Register for A2P 10DLC (do this first, it takes days)

In Twilio: **Messaging → Regulatory Compliance → A2P 10DLC**.

1. **Register your brand.** You need your legal business name, EIN, and
   business address exactly as they appear on your tax paperwork. A mismatch is
   the number one cause of rejection.
2. **Create a campaign.** Use case is usually *Mixed* or *Marketing*. You will
   be asked for two sample messages — paste real ones from your templates, and
   make sure both end with "Reply STOP to opt out."
3. **Explain how you get consent.** This is the part that gets campaigns
   rejected. You need a real answer: a form on your site with a checkbox, a
   lead-gen partner's opt-in language, an inbound enquiry. Have the screenshot
   or the contract ready.
4. Vetting takes anywhere from a day to two weeks. Budget for it.

### 6b. Create a Messaging Service and point the dialer at it

**Messaging → Services → Create Messaging Service.**

- Add your SMS-capable numbers to its sender pool.
- Attach the approved campaign from 6a.
- Under **Opt-Out Management**, leave Advanced Opt-Out on. Twilio then handles
  STOP/START replies itself, and the dialer stays out of the way.
- Copy the Service SID (starts with `MG`) into `TWILIO_MESSAGING_SERVICE_SID`
  in your environment, and set `COMPANY_NAME` to your business name while you
  are there. Restart.

The admin **Texting** tab will stop warning you once the service SID is set.

### 6c. Set the rest up in the app

1. **Numbers** tab → mark which numbers may send texts.
2. **Texting** tab → optionally pin one number as the default sender.
3. Each employee opens **Texts** in their console and writes their own
   templates. Merge fields drop in with one click:
   `{{first_name}}`, `{{business}}`, `{{agent_first_name}}`,
   `{{company_name}}`, plus any spare column from your spreadsheet like
   `{{Requested Amount}}`.
4. Under **Auto-texts**, they pick when a message sends by itself — they
   answered, they did not answer, we hit voicemail, the line was busy, or a
   specific disposition — with an optional delay.

### What your employees do with it

- On a live call, **Text them** opens the composer with that lead loaded.
- After a call, one-tap template buttons appear next to the disposition
  buttons. One click sends.
- **A group** mode: pick a list, filter to *people who did not answer* or
  *people I spoke to*, tick who gets it, send. Up to 200 at a time, dripped out
  so carriers do not see a burst.
- Replies land in **Text replies** on the right of their screen and in the
  **Replies** tab, with a two-sided thread they can answer from.

### The texting rules you do not get to skip

| Guard | What it does | Default |
|---|---|---|
| Quiet hours | A text written at 11pm goes out at 8am **their** time. It is queued, not dropped. | on |
| Opt-out line | "Reply STOP to opt out." is appended unless your message already says STOP. | on |
| STOP handling | Adds them to the opt-out list *and* the Do Not Call list, closes the lead, and cancels anything still queued for them. | always |
| Daily cap | Per agent, so one person cannot burn your whole sending reputation in an afternoon. | 500 |
| Drip rate | Bulk sends go out a few per second instead of all at once. | 3/sec |

Texting carries the same TCPA exposure as calling, plus carrier rules on top.
The short version: you need prior express written consent for marketing texts,
every message needs an opt-out, and STOP must be honoured immediately. Your
attorney should see your consent language before the first blast — not after.

---

## Step 7 - Employee accounts

Employees create their own accounts, so you are not handing out passwords.

1. Set `SIGNUP_ALLOWED_DOMAINS=brookestonefunding.com` in your environment.
   **Do not leave this blank** — an empty value means anyone with the link can
   create an account.
2. Send your team to `https://YOUR-APP-URL/signup`. They put in their name,
   their work email and a password, and they are in.
3. If you would rather approve each one, set `SIGNUP_REQUIRE_APPROVAL=true`.
   New signups then wait in **Admin → People** until you click Approve.
4. You can also add someone directly: **Admin → People**, leave the password
   blank, and they get an emailed invite to pick their own.

**Forgot password** works from the sign-in page. They get a single-use link
that expires in an hour.

### Email setup (needed for resets and invites)

Nothing about passwords works until email does.

1. Create a free account at [resend.com](https://resend.com).
2. **Domains → Add domain**, enter `brookestonefunding.com`, and add the DNS
   records it shows you at your registrar. Verification usually takes minutes.
3. **API Keys → Create**, copy the key into `RESEND_API_KEY`.
4. Set `EMAIL_FROM` to something on that domain, like
   `Brookestone Dialer <dialer@brookestonefunding.com>`.
5. Restart. Test it by clicking "Forgot your password?" on the sign-in page.

> Until this is set up, the app prints reset links to the server log instead of
> emailing them, and **Admin → People → Email reset link** shows you the link
> so you can send it yourself.

---

## Step 8 - AI notes and the CRM

Every conversation gets written up automatically, tuned for what an MCA desk
needs to know.

### 8a. Turn on recording

AI notes are only as good as their input. Without recording, the note is
written from whatever the rep typed.

1. Set `RECORD_CALLS=true`.
2. Check your state. **Eleven states require every party to consent** to being
   recorded. The app plays `RECORDING_NOTICE` to the merchant before connecting
   — keep it on.
3. You can record some lists and not others: **Admin → Call lists → Recording**
   has a per-list override.

### 8b. Turn on transcription

`TRANSCRIBE_PROVIDER=twilio` is the default and needs no new vendor:

1. Twilio Console → **Voice Intelligence → Services → Create**.
2. Copy the Service SID into `TWILIO_INTELLIGENCE_SERVICE_SID`.

If you would rather use Deepgram (faster and cheaper), set
`TRANSCRIBE_PROVIDER=deepgram` and `DEEPGRAM_API_KEY`.

### 8c. Turn on the note writer

1. Get an API key at [console.anthropic.com](https://console.anthropic.com).
2. Put it in `ANTHROPIC_API_KEY`. Restart.

Roughly one to three cents per call summarised.

### What you get

Under **Merchants** (in the top bar of the dialer):

- **My day** — callbacks that are overdue and due, today's numbers, your
  pipeline, and your latest AI notes.
- **Merchants** — search every business by name, owner, phone or email. Filter
  by stage, by owner, by "only mine".
- **Pipeline** — deal counts and dollars at each stage, from New lead through
  Underwriting to Funded.
- **A merchant record** — the deal fields, every AI note, and one timeline with
  every dial, text, note, stage change and field edit in it.

The AI note on each call gives you:

| What | Why it matters on an MCA desk |
|---|---|
| Summary | What the merchant actually said, in three sentences |
| Interest read | hot / warm / cold / dead — sort your callback list by it |
| Extracted deal data | Revenue, time in business, positions, the ask, use of funds — written into blank fields on the record |
| Objections | In the merchant's own words, so the next rep does not walk into it |
| Risk flags | Stacking, tax liens, bankruptcy, restricted industry, do-not-call requests |
| The callback | Booked automatically if the merchant named a time |
| Coaching | One line for the rep |

**It only ever fills blanks.** A number a person typed is never overwritten by
the model, and a stage a person set is never walked backwards.

---

## Step 9 - Reports

Nothing to set up. Every employee gets **Reports** in the top bar and can run
their own numbers whenever they want.

Set `REPORT_TIMEZONE` to your business's timezone (default
`America/New_York`) so that "today" and "yesterday" line up with your shifts
rather than with UTC.

### What a rep sees

| Section | What is in it |
|---|---|
| Dialing | Dials, connects, contact rate, merchants reached, voicemails, no answers — each with the change versus the previous equivalent period |
| Talk time | Total, average per connect, longest call, hours on the dialer, talk minutes per hour dialing, and the share of dialer time actually spent talking |
| Over time | Dials and connects by day — the filled part of each column is the people who picked up — plus talk time by day |
| Conversation length | How many calls ran under a minute, one to three, three to ten, over ten |
| Outcomes | What the connected calls were dispositioned as, with the talk time behind each |
| The floor | Everyone's numbers side by side, sorted by talk time |

They can group by day, hour of day, call list or disposition, pick any date
range, show the raw table, and download the whole thing as Excel.

### What only an admin sees

- Anyone else's numbers, or the whole floor at once.
- Grouping **by person**.

A rep asking the API for a colleague's numbers is ignored, not obeyed.

### The one setting

**Admin → Settings → "Let employees see the team leaderboard in Reports"**. On
by default. Turn it off and only administrators see the floor comparison; reps
still get their own numbers.

### Reading the talk-time numbers

- **Hours on the dialer** comes from when reps pressed START and STOP, not from
  when they signed in. A session left open overnight is capped so it cannot
  quietly inflate the denominator.
- **Share of dialer time spent talking** is the honest utilisation number.
  Twenty to thirty percent is a healthy MCA desk; much lower usually means the
  list is tired, not that the rep is.
- **Talk per hour dialing** is the one to coach on. It goes up when reps get
  better at qualifying fast, and it goes down when they chase dead deals.

---

## Local caller ID

People answer a number that looks like their neighbour. This is on by default
and lives under **Admin → Numbers → Local presence**.

When the dialer picks which of your numbers a merchant sees, it works down this
list and stops at the first match:

1. **The number that already called them.** A second attempt should look like
   the same person calling back, not a new stranger.
2. **Their own area code.** A Brooklyn merchant sees your 718.
3. **Their state.** No 718? A 212 still reads as "someone in New York".
4. **Their timezone.** At least the call is not coming from three hours away.
5. **Anything active**, and the report will tell you it was not a local match.

Within whichever tier wins, the **least recently used** number goes next, so one
number does not carry the whole floor and get flagged for it.

### Seeing where you are weak

The **Local presence** panel shows what share of your merchants you can ring
from a matching area code, from the same state only, from the same timezone
only, or not locally at all. Underneath it lists the area codes in your lists
you *cannot* ring locally, biggest first.

That list is a shopping list. A Twilio number is about $1.15 a month, so if 300
of your merchants sit in one area code you have no number for, buying it is an
easy call. Buy the number, press **Import all numbers from Twilio**, and the
panel updates.

### Changing the behaviour

The dropdown on that panel has three settings:

| Setting | What it does |
|---|---|
| Area code, then state, then timezone | The default, described above |
| Only an exact area code match | Never pretends; if you have no local number they see whatever you do have |
| Do not match, just rotate evenly | Spreads calls across your numbers with no geography at all |

Your reports show **"Dialed from a matching area code"** as a percentage, so you
can see whether buying more numbers actually moved your contact rate.

> Local presence is a legitimate practice, but do not confuse it with spoofing.
> Every number here is one you actually own in Twilio and that reaches you if
> someone calls it back. Displaying a number you do not control is illegal under
> the Truth in Caller ID Act, and this app cannot do it.

---

## Step 10 - Your admin portal

`/admin` is yours. Four things live there that you will actually use.

### People

| What | How |
|---|---|
| Make someone an administrator | Change the **Role** dropdown on their row. Takes effect on their next page load. |
| Take administrator access away | Same dropdown, back to Employee. |
| Change how many lines someone may dial | Type over the number on their row. |
| Pause someone | **Disable**. They cannot sign in; everything else stays exactly as it was. Reversible. |
| Remove someone for good | **Remove**. Asks who takes over their merchants and open callbacks, then deletes the account. Their calls, texts and AI notes are kept. |
| See what someone is doing | Click their name. |

Three guards you cannot switch off, because they are the ones that lock a
company out of its own dialer: you cannot demote yourself, you cannot switch off
your own account, and you cannot remove the last administrator. Promote someone
else first.

> **Disable, don't remove, for a normal departure.** Removal is permanent.
> Disabling keeps the account and everything attached to it, and takes one click
> to undo when they come back.

### Activity log

Who signed in, who failed to sign in and from what IP, who changed a role, who
imported or deleted a call list, who edited Do Not Call, who changed settings,
and **who downloaded data**. Filter by person or by kind.

The last one is the point: if a rep exports your entire call log on their way out
the door, this is where it shows up. Entries survive the account being deleted.

### System check

Press **Run the check**. It genuinely calls Twilio, Anthropic and your email
provider - it does not just look at whether a variable is set. It catches:

- an Account SID or auth token that is wrong rather than missing
- a Twilio balance about to run out mid-shift
- an API key that no longer exists on the account, so agent phones fail
- **a TwiML app still pointing at an old deployment** - the single most common
  cause of "the agent connects but hears nothing"
- a caller ID you no longer own, which fails every call with error 21210
- texting sending from a bare number with no A2P registration
- whether Twilio has actually reached your webhooks recently
- an Anthropic or Resend key that is being rejected
- a sending domain that is not verified, so no password reset will ever arrive
- compliance guards someone has switched off

Every failure comes with the fix written out. Run it after any deploy, and
whenever something feels off.

### Dashboard

Who is dialing right now, today's numbers, and the two URLs to paste into
Twilio.

---

## What it costs to run

Rough monthly numbers for 5 agents dialing 6 hours a day:

| Item | Estimate |
|---|---|
| Render hosting | $7 |
| Twilio numbers (5) | $6 |
| Outbound minutes (~$0.014/min, ~25k min) | $350 |
| Answering machine detection ($0.0075/call, ~30k calls) | $225 |
| Texts (~10k @ $0.0079 + $0.0025 carrier fee) | $105 |
| A2P 10DLC campaign | $12 |
| Call recording storage (~25k min @ $0.0005) | $13 |
| Transcription (~6k connected min @ $0.005) | $30 |
| AI notes (~6k calls @ ~$0.015) | $90 |
| Resend email | $0 (free tier) |
| **Total** | **~$840/mo** |

Turn `ENABLE_AMD=false` to save the detection cost, but agents will land on
voicemail greetings regularly. Most desks find it pays for itself.

---

## Before you dial the first number

This dialer is a tool; how you use it is on you. The things that actually get
call centres fined:

- **Abandoned calls.** If two people answer at once, one gets the recorded
  apology instead of a person. Federal safe harbour caps that at **3% of
  answered calls**. The dialer tracks the rate, shows it on the dashboard, and
  automatically trims lines when it drifts over. Do not switch that off.
  With 5 lines and one agent you will blow through 3% — that setting exists
  because it *can* be right for a big list, not because it is a good default.
- **Calling hours.** 8am-9pm in the *lead's* local time. On by default; the
  dialer works out the timezone from the area code.
- **Do Not Call.** Federal DNC registry, plus your own internal list. The
  internal list is built in — scrub against the federal registry separately
  (you need a subscription at telemarketing.donotcall.gov) and upload it here.
- **Recording.** Off by default. Eleven states require *all* parties to
  consent. If you turn it on, `RECORDING_NOTICE` is played to the called party.
- **Caller ID.** Must be a number you own and that reaches you if called back.
  Do not spoof.

None of the above is legal advice, and MCA/business-financing calling has its
own rules on top of these. Have your attorney look at your script and your
list sources.

---

## Troubleshooting

**"Phone: microphone blocked"**
Click the padlock in the browser address bar, allow the microphone, reload.
The site must be on https for browsers to allow it at all.

**Agent connects but hears nothing / leads hear nothing**
Almost always the TwiML App Request URL. Go to **Admin → System → Twilio
setup** and press **Run Twilio setup** — it re-points the URL at wherever this
app actually is. If it comes back saying the URL "belongs to something else",
that TwiML App is being used by another application; either point it at
`https://YOUR-APP-URL/twiml/agent-leg` (POST) yourself or let auto-setup make
a fresh one by clearing `TWILIO_TWIML_APP_SID`. Check `PUBLIC_URL` matches the
address you actually open in your browser.

**"No caller ID numbers configured"**
Admin → System → **Run Twilio setup**, which adopts every number on the
account. If it finds none, you have not bought one in Twilio yet.

**Calls fail immediately with error 21210 or 21606**
The `from` number is not one you own in Twilio, or it is not voice-enabled.

**Everything works, then dies after a few minutes of idle**
You are on Render's free plan. Move to Starter.

**Nothing dials, status stays "Ready"**
Either the list is finished, everything left is outside calling hours, or the
leads are scheduled for a later callback. The banner on the agent screen says
which.

**Texts say "sent" but nobody receives them**
Almost always A2P 10DLC. Unregistered numbers get filtered silently by US
carriers — Twilio reports success, the carrier bins it. Finish Step 6a.

**Text error 30007 (message filtered)**
Carrier blocked it. Usually a missing opt-out line, a link shortener the
carriers distrust (bit.ly and friends), or an unregistered campaign.

**Text error 21610**
That number replied STOP at some point. It stays blocked until they text
START. You can clear it in Admin → Texting → Opted out, but only if they
actually asked you to.

**Replies never show up**
The number's "A message comes in" webhook is not set to
`https://YOUR-APP-URL/twiml/sms-inbound`. Admin → System → **Run Twilio
setup** sets it on every SMS-capable number you own.

**Nobody gets password reset emails**
Either `RESEND_API_KEY` / `EMAIL_FROM` are not set, or your domain is not
verified in Resend. Until then the links appear in the server log and under
Admin → People → Email reset link.

**"Sign-up is limited to..." when someone tries to join**
Their email is not on `SIGNUP_ALLOWED_DOMAINS`. Add the domain, or add them
directly under Admin → People.

**AI notes stay stuck on "Writing the note"**
`ANTHROPIC_API_KEY` is missing, or transcription cannot reach the recording.
The merchant record shows the actual error under the note. A failed note has a
"Try again" button.

**AI notes say "from your notes" instead of "from the recording"**
Either `RECORD_CALLS` is false, that list has recording switched off, or the
transcription provider is not configured. The note is still written, just from
thinner input.

**Notes are being skipped**
Calls shorter than `AI_MIN_TALK_SECONDS` (20 by default) are deliberately
skipped rather than summarised from nothing.

**Twilio error 13223 / calls rejected**
Twilio blocks some destination numbers by default (premium rate, some
international). Check Voice → Settings → Geo permissions.

---

## Where the data lives

Everything is in one SQLite file (`data/dialer.db`). On Render it sits on the
persistent disk defined in `render.yaml`, so it survives deploys. Back it up
by downloading that file, or just export each list to Excel from the admin
screen when you finish it.
