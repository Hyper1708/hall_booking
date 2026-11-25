# Hall booking

Book the university's halls from a Telegram group. First come, first served.

- A **mini app** inside Telegram shows the halls by day, hour by hour. Tap a free hour, enter your name and department, book.
- If the hall is already taken, or the day is a public holiday, the booking is **Incomplete** and the app says why.
- The **bot** posts in the group when someone books or cancels, and every morning it posts:
  - today's bookings per hall, so the cleaning staff know which halls to prepare;
  - the bookings 3 days ahead.
- Send **`/remind`** (or just `remind` / `រំលឹក`) in the group and the bot answers, within about a minute, with every booking for the next 7 days, today included.
- Cambodian public holidays update by themselves every week.
- English and Khmer, switched with one button. More languages: add a block in `docs/i18n.js`.

Nothing to host: the data is a Google Sheet, the server is Google Apps Script, and the page is on GitHub Pages. All free.

## How it fits together

```
Telegram group ── pinned link ──> Mini app (docs/, on GitHub Pages)
      ^                                 │  POST {action, initData, ...}
      │ bot posts                       v
      └──────────── Apps Script web app (apps-script/) ──> Google Sheet
                      │  weekly: holidays from Google Calendar + Nager.Date
                      └  daily 07:00: morning list to the group
```

| Part | Files | Job |
|---|---|---|
| Rules | `apps-script/Core.js` | Clash check, holiday merge, bot message text, Telegram signature check. No Google services, so it is unit-tested with Node. |
| API | `apps-script/Code.js` | `list`, `book`, `cancel`. Checks the Telegram signature and group membership on every request. |
| Sheet | `apps-script/Data.js` | Reads and writes the tabs. |
| Bot | `apps-script/Telegram.js` | Sends messages, checks group membership. |
| Bot commands | `apps-script/Bot.js` | `/remind` and keywords. A timer asks Telegram for new messages every minute; only the group gets an answer. |
| Timers and setup | `apps-script/Jobs.js` | Morning post, holiday sync, sheet menu, first-time setup. |
| Mini app | `docs/` | The page people use. |

### Safety rules in the code

- **No double booking.** Booking takes a script lock, re-reads the sheet, checks, writes, and flushes before unlocking. Two people tapping the same hour at the same second: one gets it, the other gets "Incomplete: already booked".
- **No fake users.** Every request carries Telegram's signed `initData`. The server checks the signature with the bot token and checks that the person is in the group. Requests older than 24 hours are refused.
- **The bot token never leaves Apps Script.** It is stored in Script Properties, not in the code or the sheet.
- **User text is never run as code.** The page writes it with `textContent`; bot messages escape HTML; leading `= + - @` is removed so the sheet never runs it as a formula.
- **Dates stay dates.** Every cell is plain text, so Sheets cannot turn `2026-12-03` or `09:00` into something else.
- **A failed holiday download never deletes holidays.** Old rows stay until both sources answer.

## Setup (about 30 minutes)

### 1. Telegram bot
1. In Telegram, open **@BotFather**, send `/newbot`, follow the steps. Copy the **token**.
2. Add the bot to your hall-booking group.

### 2. Google Sheet and Apps Script
1. Create a new Google Sheet, for example "Hall booking".
2. **Extensions > Apps Script**.
3. For each file in `apps-script/`, create a script file with the same name (`Core`, `Code`, `Data`, `Telegram`, `Bot`, `Jobs`) and paste the content. Delete the empty `Code.gs` content first.
4. **Project Settings** (gear icon) > tick **Show "appsscript.json" manifest file**. Open `appsscript.json` in the editor and replace it with `apps-script/appsscript.json`.
5. **Project Settings > Script properties > Add script property**: `BOT_TOKEN` = the token from BotFather.
6. Reload the sheet. A **Hall booking** menu appears. Click **Set up sheets and timers** and allow the permissions. This creates the tabs (`Bookings`, `Halls`, `Holidays`, `Settings`), the morning timer, the weekly holiday timer, and fills the holidays.
7. In the Telegram group send `/start@YourBotName`. Then in the sheet: **Hall booking > Find group chat ID**. Add a script property `GROUP_CHAT_ID` with that number (it starts with `-`).

Tip: if you use the command line, [clasp](https://github.com/google/clasp) can push `apps-script/` instead of copy-paste.

### 3. Publish the API
1. In Apps Script: **Deploy > New deployment > Web app**.
2. **Execute as: Me**. **Who has access: Anyone**. (Telegram's in-app browser is not signed in to Google. The Telegram signature check is what keeps strangers out.)
3. Copy the web app URL (it ends in `/exec`).
4. Paste it into `docs/config.js` and commit.

After you change Apps Script code later: **Deploy > Manage deployments > Edit (pencil) > Version: New version > Deploy**. The URL stays the same. Without a new version, the web app keeps running the old code.

### Turn on `/remind`
1. In the sheet: **Hall booking > Turn on /remind**. This starts a timer that checks Telegram for new messages once a minute. No new deployment is needed.
2. For keywords without `/` (`remind`, `រំលឹក`): make the bot a **group admin** (no rights needed). Telegram only shows a bot the messages that start with `/` unless it is an admin.
3. In the group, send `/remind` or `remind`. The bot answers within about a minute.
4. No answer after 2 minutes? **Hall booking > Check /remind** shows the last check time and the last error.

Why a timer and not a Telegram webhook: Apps Script answers every web app request with a 302 redirect, which Telegram counts as a failed delivery and retries. Asking Telegram for new messages avoids that, needs no public entry point, and runs the saved code without a redeploy. The cost is up to a minute of delay, and about 1,440 short runs a day, well inside Apps Script's free limits.

Safety: the bot answers only in the group in `GROUP_CHAT_ID`, only to `/remind` or a message that is exactly a keyword, and handles each message once.

### 4. Publish the mini app page
1. On GitHub, make this repository **public** (free GitHub Pages needs it). No secret is in the code.
2. **Settings > Pages > Deploy from a branch > main, /docs**.
3. The page appears at `https://<your-github-name>.github.io/hall_booking/`.

### 5. Connect the mini app to the bot
1. In **@BotFather** send `/newapp`, pick your bot, follow the steps. For the Web App URL, give the GitHub Pages address. Choose a short name, for example `book`.
2. BotFather gives you a link like `https://t.me/YourBotName/book`.
3. Post that link in the group and pin it. Tapping it opens the mini app.

### 6. Check it works
- [ ] Open the pinned link: the halls show, no error.
- [ ] Book an hour: the group gets a "New booking" message.
- [ ] Book the same hour again: "Incomplete: already booked ... by ...".
- [ ] Pick a public holiday: "Incomplete: Public holiday ...".
- [ ] A Telegram account that is not in the group gets "Only members of the group can use this app".
- [ ] Sheet menu **Post today's list now**: the morning list appears in the group.
- [ ] Switch language: every text changes.

## Sheet tabs

| Tab | You may edit | Notes |
|---|---|---|
| `Bookings` | Rarely | Written by the app. `status` is `active` or `cancelled`. |
| `Halls` | Yes | `id` must not change once used. Set `active` to `FALSE` to hide a hall. |
| `Holidays` | Yes | Rows with `source` = `auto` come from the internet. Set `enabled` to `FALSE` to un-block a day. Add your own rows (any other `source`, for example `manual`) for university closures. |
| `Settings` | Yes | See below. |

| Setting | Default | Meaning |
|---|---|---|
| `OPEN_HOUR` | 7 | First bookable hour. |
| `CLOSE_HOUR` | 18 | Halls close at this hour (last booking ends here). Max 23. |
| `MAX_DAYS_AHEAD` | 180 | How far ahead people can book. |
| `NOTICE_DAYS` | 3 | The morning post also lists bookings this many days ahead. |
| `MORNING_HOUR` | 7 | Hour of the morning post. After changing it, run **Set up sheets and timers** again. |
| `BOT_LANG` | both | Bot message language: `km`, `en` or `both`. |
| `REMIND_DAYS` | 7 | How many days `/remind` lists, today included. Max 31. |
| `REMIND_WORDS` | remind, រំលឹក | Keywords that work like `/remind`, comma-separated. The message must be only the keyword. Leave empty to turn keywords off. |

## Holidays

Two free sources, merged:
- **Google Calendar's Cambodia holidays**: most complete dates, English names.
- **Nager.Date**: Khmer names, but it misses some days (for example Visak Bochea).

A day is blocked if either source lists it. Neither is the official government announcement, so check the `Holidays` tab when the government publishes the yearly list, and add or switch off days there.

## Tests

```bash
npm test
```

Browser check of the mini app (needs Playwright):

```bash
npm run test:ui
```
