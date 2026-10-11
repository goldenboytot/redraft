# Redraft

A private chat tool that tailors a CV to one job description, the way Tobi's best resume chats did: upload, analyse, answer questions, approve anything beyond the CV, iterate, download the Word resume, then write the cover letter from it.

- **Next.js** on Vercel, **Supabase** for invite-only sign-in, per-user saved sessions, and private final-file storage, **Claude API** for the writing.
- Claude Sonnet 5.5 by default; **Deep mode** switches to Claude Opus 5.5.
- Uploaded files are turned into text on the server; the original uploads are discarded. Extracted text and chat history are saved in that user's session.
- Generated resumes, cover letters, and keyword reports are editable Word `.docx` files only, using Tobi's Calibri house CV format. PDF is supported only as an uploaded source document, never as an export format. Generated resumes and cover letters are saved automatically as private Word files when the session syncs. Each distinct version is retained under the user and session. **Save as final** creates a named final copy; saving a resume as final marks that session completed. Keyword reports can be saved explicitly.
- Output always follows the house format in `lib/redraft/rules.ts`, never the candidate's original layout.

## One-time setup (about 20 minutes)

### 1. Supabase
1. Create a project at supabase.com. Pick the **Canada (Central)** region.
2. **SQL Editor** → paste `supabase/schema.sql` → Run to create per-user sessions.
3. Paste `supabase/final-files-schema.sql` → Run to create private final-file storage. For an existing Redraft project, run only this new SQL file.
4. **Authentication → Sign In / Providers → Email**: keep Email on. Turn **off** "Allow new users to sign up" (invite only).
5. **Authentication → Users → Invite user**: add yourself and each person in your circle.
6. **Project Settings → API**: copy the **Project URL** and the **publishable key** (or the legacy anon key).

### 2. Anthropic
1. console.anthropic.com → **API keys** → create a key.
2. **Billing → Limits**: set a monthly spend limit.

### 3. Vercel
1. **Add New → Project** → import this GitHub repo.
2. Add these environment variables:

| Name | Value |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable (or anon) key |
| `ANTHROPIC_API_KEY` | Your Anthropic key |
| `CRON_SECRET` | Any long random string (protects the keep-alive ping) |
| `SUPABASE_SECRET_KEY` | Server-only Supabase secret key (or legacy service_role key), for admin reads |
| `REDRAFT_ADMIN_USER_IDS` | Your Supabase Authentication user UUID; comma-separated for multiple admins |

3. Deploy. Note the site address, e.g. `https://redraft-xyz.vercel.app`.

### 4. Connect sign-in to the site
Supabase → **Authentication → URL Configuration**:
- **Site URL**: your Vercel address.
- **Redirect URLs**: add `https://YOUR-SITE/auth/callback` (and `http://localhost:3000/auth/callback` for local use).

Done. Open the site, enter your email, click the link.

### 5. Set up custom SMTP (do this before inviting real users)
Supabase's built-in email sender is capped at **2 emails/hour per project** — fine for the one test invite, not for real use. Every sign-in link, invite, and password reset shares that quota, so without custom SMTP, people will quickly start seeing "link couldn't be sent" or expired-link errors.

Supabase → **Authentication → Emails → SMTP Settings**: add credentials from a provider like Resend or Postmark (free tiers cover invite-only use easily).

## Admin sessions and outputs

Set `SUPABASE_SECRET_KEY` and `REDRAFT_ADMIN_USER_IDS` in your local environment and Vercel, then redeploy. Find your user UUID in Supabase → Authentication → Users. Never use a `NEXT_PUBLIC_` prefix for the secret key. If a secret was previously exposed in a browser bundle, rotate it in Supabase.

Only accounts in the server-side admin allowlist see the **User view / Admin view** switch in the header. User view at `/` shows only that account’s own sessions; Admin view at `/admin` shows everyone’s. Other accounts have only the normal user view and cannot access admin pages or downloads. `/admin` lists all users’ sessions, with user email, completion status, saved output count, and update time. Filter by title, click a user to filter their sessions, or show only completed sessions. Open a session to review its saved conversation, latest resume and cover letter, and download its Word files. This is a read-only view. A session is completed when its resume is explicitly saved as final; autosaved drafts remain in progress. Existing sessions have no completion marker until a resume is saved as final again.

Every admin page and download checks the signed-in user against the server-only UUID allowlist before creating a privileged Supabase client. Ordinary clients continue to use the existing per-user database and Storage policies. No public bucket or broader read policies are needed.

The existing `sessions`, `final_files`, and `redraft-finals` bucket are reused; no new schema migration is required if both setup SQL files have already been run. Files live at `<user UUID>/<session ID>/<file key>.docx`. Automatic saves deduplicate identical content and retain changed versions. Older sessions gain Word files when opened and saved; they are not bulk-backfilled. If file saving fails, the session remains saved and the Files tab offers **Retry saving outputs**. Reconnecting also retries the current session. As with session autosave, closing the browser before a save finishes can interrupt it.

Run `npm run check:storage` for authorization and output persistence tests, and `npm run check:docx` for Word-format checks.

## Day to day
- **Invite someone**: Supabase → Authentication → Users → Invite user.
- **Remove someone**: delete the user there. Their sessions are deleted with them.
- **Sign in**: the login page offers either a one-time sign-in link (magic link) or email + password. New invites only have the magic-link option until they set a password via **Forgot password**.
- **Change the method**: edit `lib/redraft/rules.ts` and push. Vercel redeploys.
- **Keep-alive**: `vercel.json` pings Supabase once a day so the free project doesn't pause from inactivity.

## Local development
```bash
cp .env.example .env.local   # fill in the values
npm install
npm run dev
```

## Where things live
| Path | What it does |
| --- | --- |
| `lib/redraft/rules.ts` | The house method and reply format Claude follows |
| `lib/redraft/app.js` | Chat, confirm cards, resume editor, keyword report, sessions, and tagged final-file actions |
| `lib/redraft/builders.js` | Editable `.docx` builders in Tobi's Calibri house CV format |
| `app/api/chat/route.ts` | Calls Claude with prompt caching and streams the reply |
| `app/api/extract/route.ts` | Turns .docx / .pdf / .txt into text; original uploads are not stored |
| `app/login/page.tsx` | Sign-in page: magic link, email + password, and forgot-password |
| `app/auth/callback/route.ts` | Exchanges the one-time code from any auth email for a session |
| `app/auth/update-password/page.tsx` | Where a password-reset link lands so the user can set a new password |
| `proxy.ts` | Sends anyone not signed in to `/login` |
| `app/admin/` | Read-only admin session list and details |
| `app/api/admin/files/[id]/route.ts` | Authorized private file downloads for admins |
| `lib/redraft/output-storage.js` | Automatic Word output archiving and deduplication |
| `supabase/schema.sql` | Per-user session table and row-level security |
| `supabase/final-files-schema.sql` | Separate final-file table, row-level security, and private Storage policies |
