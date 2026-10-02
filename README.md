# Redraft

A private chat tool that tailors a CV to one job description, the way Tobi's best resume chats did: upload, analyse, answer questions, approve anything beyond the CV, iterate, download the Word resume, then write the cover letter from it.

- **Next.js** on Vercel, **Supabase** for invite-only sign-in, per-user saved sessions, and private final-file storage, **Claude API** for the writing.
- Claude Sonnet 5.5 by default; **Deep mode** switches to Claude Opus 5.5.
- Uploaded files are turned into text on the server; the original uploads are discarded. Extracted text and chat history are saved in that user's session.
- Generated resumes, cover letters, and keyword reports are editable Word `.docx` files only, using Tobi's Calibri house CV format. PDF is supported only as an uploaded source document, never as an export format. Generated files are stored in the user's private final-files area only when the user explicitly chooses **Save as final**.
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

3. Deploy. Note the site address, e.g. `https://redraft-xyz.vercel.app`.

### 4. Connect sign-in to the site
Supabase → **Authentication → URL Configuration**:
- **Site URL**: your Vercel address.
- **Redirect URLs**: add `https://YOUR-SITE/auth/callback` (and `http://localhost:3000/auth/callback` for local use).

Done. Open the site, enter your email, click the link.

### 5. Set up custom SMTP (do this before inviting real users)
Supabase's built-in email sender is capped at **2 emails/hour per project** — fine for the one test invite, not for real use. Every sign-in link, invite, and password reset shares that quota, so without custom SMTP, people will quickly start seeing "link couldn't be sent" or expired-link errors.

Supabase → **Authentication → Emails → SMTP Settings**: add credentials from a provider like Resend or Postmark (free tiers cover invite-only use easily).

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
| `supabase/schema.sql` | Per-user session table and row-level security |
| `supabase/final-files-schema.sql` | Separate final-file table, row-level security, and private Storage policies |
