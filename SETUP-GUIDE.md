# SETUP GUIDE — from zero to a working journal

You do **not** need a terminal, VS Code, Python or Node. Everything is done in your web browser.
Time needed: about 45–60 minutes the first time. Cost: €0 (Supabase free plan; GitHub — see Step 3).

Follow the steps **in order**. Tick each one off. Do not skip any.

---------------------------------------------------------------------------------------------------

## STEP 0 — Before you start (5 min)

You need:
1. An email address you can read.
2. A password manager (the one built into Chrome / Safari / Edge is fine).
3. Your **PropReports API token**.
   - Log in at https://alaric.propreports.com
   - Open your profile (top right) and find **API Tokens**, then create a token. (If you cannot find it, the PropReports "API v2" documentation page explains where tokens are created.)
   - Copy it. **Keep it in your password manager only.** Never paste it into GitHub, into a chat, or into the website.
4. On your computer: **unzip** the file `trading-journal-complete.zip` (double-click it). You get a folder called `trading-journal`.
   - **Mac:** press `Cmd + Shift + .` inside Finder to show hidden folders (you need to see `.github`).
   - **Windows:** in File Explorer → View → Show → **Hidden items**.

---------------------------------------------------------------------------------------------------

## STEP 1 — Create your Supabase project (10 min)

Supabase is the online database + login + server for the journal.

1. Go to https://supabase.com → **Start your project** → sign in (using GitHub or email).
2. Click **New project**.
   - **Name:** `trading-journal`
   - **Database password:** click **Generate a password**, then **copy it into your password manager** and label it "Supabase database password". *You cannot see it again later.*
   - **Region:** pick the closest to Bulgaria (e.g. *Central EU (Frankfurt)*).
   - **Pricing plan:** Free.
   - Click **Create new project**. Wait 1–2 minutes until the dashboard appears.
3. **Write down four values** (put them in a note for now; you will paste them into GitHub in Step 4):
   - **A. Project reference ID** — click the ⚙ **Project Settings** (bottom-left) → **General** → copy **Reference ID** (about 20 letters).
   - **B. Project URL** — Project Settings → **API** (or **Data API**) → copy **Project URL** (looks like `https://abcdefgh.supabase.co`).
   - **C. Anon / public key** — same page → copy the key named **anon public** (a very long text starting with `eyJ…`). If your screen only shows a *Publishable key* (starts with `sb_publishable_`), copy that instead — it is the same idea. This key is **meant to be public**. Do **not** copy the `service_role` / `secret` key anywhere.
   - **D. Access token** — click your avatar (top right) → **Account preferences** → **Access Tokens** → **Generate new token** → name it `github-deploy` → copy it immediately.
   - (E. The database password from step 2.)

### 1b. Turn OFF public sign-up (important for privacy)
1. In Supabase: **Authentication** (left menu) → **Sign In / Providers** (or **Providers** → **Email**).
2. Switch **OFF** "Allow new users to sign up" (it may be called *Enable sign ups*). Click **Save**.

### 1c. Create YOUR login
1. **Authentication** → **Users** → **Add user** → **Create new user**.
2. Type your email, a strong password (let your password manager generate it), tick **Auto Confirm User**, click **Create user**.
3. This email + password is how you log in to the journal. Save them in your password manager.

### 1d. Store the PropReports token safely (server-side secret)
1. In Supabase: **Edge Functions** (left menu) → **Secrets** (tab / button).
2. **Add new secret**:
   - **Name:** `PROPREPORTS_TOKEN` (exactly, capital letters)
   - **Value:** paste your PropReports token
   - Save.
3. The token now lives only on Supabase's server. The website can never see it.

---------------------------------------------------------------------------------------------------

## STEP 2 — Create the GitHub account and repository (10 min)

1. Go to https://github.com → **Sign up** (or sign in).
2. Click **+** (top right) → **New repository**.
   - **Repository name:** `trading-journal`
   - Choose **Private** *(see Step 3 first if you are on the free GitHub plan)*.
   - Do **not** tick "Add a README".
   - Click **Create repository**.
3. On the empty repository page click **uploading an existing file**.
4. Open the unzipped `trading-journal` folder. **Select everything inside it** (Ctrl/Cmd + A) and **drag it all** into the GitHub page.
   - You must see the folders `.github`, `packages`, `scripts`, `supabase`, `web` and the files `README.md`, `SETUP-GUIDE.md` in the upload list.
   - GitHub allows about 100 files per upload. If it complains, upload in two rounds: first `supabase` + `scripts` + `.github` + the loose files, commit; then `packages` + `web`.
5. Scroll down → **Commit changes**.
6. **Check `.github` arrived:** on the repository page you should see a `.github` folder. If it is missing (some computers hide it):
   - **Add file → Create new file**, name it `.github/workflows/deploy-supabase.yml` (typing the `/` creates folders), and paste the text from the file `github-workflows/deploy-supabase.yml`. Commit.
   - Repeat for `.github/workflows/deploy-website.yml` using `github-workflows/deploy-website.yml`.

---------------------------------------------------------------------------------------------------

## STEP 3 — GitHub Pages and the "private repository" question (2 min)

GitHub Pages (the free website hosting) works with **private** repositories **only on a paid GitHub plan (Pro, about $4/month)**. On the free plan, Pages needs a **public** repository.

Pick ONE:
- **Option A (what the project asked for):** upgrade your GitHub account to **Pro** (GitHub → your avatar → Settings → Billing and plans), keep the repository **Private**.
- **Option B (free):** make the repository **Public** (Repository → Settings → scroll to *Danger Zone* → **Change visibility** → Public). This is safe for security: the repository contains **no passwords or tokens** (your PropReports token is only in Supabase; the website key is public by design; all your data is protected by your login and database rules). The only difference is that other people could read the program code — not your trades.

---------------------------------------------------------------------------------------------------

## STEP 4 — Add the GitHub settings (5 min)

In your repository: **Settings** → **Secrets and variables** → **Actions**.

**Tab "Secrets" → New repository secret** (do it twice):
| Name | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | value **D** (the access token) |
| `SUPABASE_DB_PASSWORD` | value **E** (the database password) |

**Tab "Variables" → New repository variable** (do it three times):
| Name | Value |
|---|---|
| `SUPABASE_PROJECT_REF` | value **A** (Reference ID) |
| `SUPABASE_URL` | value **B** (Project URL) |
| `SUPABASE_ANON_KEY` | value **C** (anon / publishable key) |

Names must match exactly (capitals, underscores).

Then: **Settings → Pages → Build and deployment → Source → choose "GitHub Actions"**.

---------------------------------------------------------------------------------------------------

## STEP 5 — Build the database and the server functions (5 min)

1. Repository → **Actions** tab. If GitHub asks, click **"I understand my workflows, go ahead and enable them"**.
2. Left list → **Deploy Supabase (database + functions)** → **Run workflow** (right side) → green **Run workflow**.
3. Wait 2–4 minutes. A **green ✔** means success. 
   - **Red ✗?** Click the failed run → click the red step → read the message (it says what is missing). Fix that setting (usually a typo in Step 4) and press **Re-run all jobs**. If you are stuck, send me the red message.

## STEP 6 — Publish the website (3 min)

1. **Actions** → **Deploy website** → **Run workflow** → **Run workflow**.
2. Wait for the green ✔. Click the run → under **deploy** you will see the website address, like  
   `https://YOUR-GITHUB-NAME.github.io/trading-journal/`
3. **Bookmark that address.** This is your journal.

---------------------------------------------------------------------------------------------------

## STEP 7 — First start (5–10 min)

1. Open the address. You see a **Sign in** page. Enter the email + password from Step 1c. (Let the browser save them.)
2. You see **Welcome** → click **Connect PropReports and download my history**.
3. Wait. The first download gets *all* your history and can take a few minutes. Do not close the tab.
4. The **Dashboard** opens. Check:
   - Top-right shows **Synced** and the time, with a **SYNC NOW** button.
   - **Calendar** → the week starting **Mon 31 Aug 2026** should show the same daily numbers as your report.
   - **Weekly Report** → pick that week → *Generate report…* → compare with your original PDF.
5. If the sync bar shows **"N warnings"**, open **Settings → Synchronization** and read them. A warning is not a failure — it is the journal telling you something does not match PropReports and why.

---------------------------------------------------------------------------------------------------

## EVERY DAY

1. Open your bookmark. Sign in (password manager fills it).
2. The journal **syncs by itself**. Press **SYNC NOW** any time for a fresh sync.
3. **Current Positions:** press **Edit** on a position to type its **Stop Loss**, sector, industry and notes. They are never overwritten by a sync.
4. **Calendar:** click a day, write a comment.
5. **Weekly Report:** pick the week → *Generate report…* → check the comment (it is pre-filled from your day comments) → *Generate report* → edit anything you want → **Download PDF**.

---------------------------------------------------------------------------------------------------

## IF SOMETHING GOES WRONG

| What you see | What to do |
|---|---|
| Page says "not connected to Supabase yet" | Step 4 variables missing/typo → fix → Actions → run **Deploy website** again. |
| Red ✗ in Actions: "Missing setting …" | You skipped a secret/variable in Step 4. |
| Red ✗ at "Link to your Supabase project" | Wrong `SUPABASE_PROJECT_REF`, `SUPABASE_ACCESS_TOKEN` or `SUPABASE_DB_PASSWORD`. |
| "PropReports token is not configured on the server" | Step 1d: add the secret `PROPREPORTS_TOKEN` in Supabase → Edge Functions → Secrets. |
| "PropReports rejected the API token" | Create a new token in PropReports and replace the Supabase secret. |
| "format the journal does not recognise" after sync | PropReports sends columns we did not expect. **Send me the full message** — it lists the columns received; I adjust one line. |
| First sync stops / times out | Press **Settings → Re-download full history**, or press **SYNC NOW** again; it continues safely. If it keeps failing tell me — the fix is known (download in smaller chunks). |
| Weekly numbers differ from your PropReports report | Settings → Synchronization → read the warnings, then send me the week; reconciliation is exactly what the warnings are for. |
| Prices show "PRICE UNAVAILABLE" | Yahoo Finance did not know the symbol or blocked the request; the journal never guesses a price. Try again later. |
| You forgot the journal password | Supabase → Authentication → Users → your user → **Send password recovery** (or delete and recreate the user). |

---------------------------------------------------------------------------------------------------

## HONEST LIST OF WHAT WAS NOT TESTED LIVE

Everything below was built and tested with simulated data in my workspace, which cannot reach PropReports, Supabase, Yahoo Finance or TradingView:
- The very first real sync (column names of the `positions` / `adjustments` data are taken from the PropReports docs).
- Yahoo Finance prices and TradingView sector lookups (both are unofficial, free web services that can change).
- The deploy workflows on your accounts.
- **Realized Net** on the weekly report is computed as *realized − trade costs*. Your report's $8.59 could not be reproduced from the numbers I had; compare it on the first real week.
If anything looks off in the first week, tell me exactly what you see and I will fix it.
