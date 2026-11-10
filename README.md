# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

## AI Writing Assistant

The student AI Writing Assistant is available in the Work Conduct Essay, Narrative Report, Written Report, and Daily Time Record task-note fields. It sends the selected draft and writing-type label to the authenticated Supabase Edge Function and OpenAI. When requesting an explanation, the generated suggestion is sent too. Do not include sensitive personal information. This app does not add an assistant or draft table; provider data handling follows your OpenAI account terms. Students must review a suggestion and choose **Use Suggestion** to apply it. AI assistance requires an internet connection.

The function requires a deployed Supabase project and an OpenAI API key. Never add the provider key to `.env.local`, frontend code, or any `VITE_` variable.

From the project root, link the Supabase CLI to the existing project and configure server-side secrets:

```powershell
npx.cmd supabase login
npx.cmd supabase link --project-ref YOUR_SUPABASE_PROJECT_REF
npx.cmd supabase secrets set OPENAI_API_KEY=YOUR_OPENAI_API_KEY OPENAI_MODEL=YOUR_SUPPORTED_MODEL
npx.cmd supabase functions deploy ai-writing-assistant
```

Set `OPENAI_MODEL` to a model that supports the Chat Completions API and JSON response mode. Configure usage limits and billing alerts in the OpenAI account. The function limits drafts to 6,000 characters, restricts access to authenticated student accounts, validates requests and responses, and caps generated output.

The frontend reads `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from Vite's `import.meta.env`. Set both in the root `.env.local` for local development and in Vercel's Environment Variables for each deployment environment, then redeploy. The client also accepts the older `VITE_SUPABASE_PUBLISHABLE_KEY` name as a compatibility fallback. Do not put the OpenAI key there. The Edge Function uses Supabase's server-side `SUPABASE_URL` and `SUPABASE_ANON_KEY` runtime values; the Supabase CLI supplies them when deployed. Supabase Edge Functions require no separate app redirect URL.

To test, configure the secrets and deploy the function using the commands above, run `npm.cmd run dev`, sign in as a student, and open a Work Conduct Essay, Narrative Report, Written Report, or Daily Time Record task field. Enter a short draft and test **Improve Draft**, **Try Again**, **Explain Corrections**, and **Use Suggestion**. Confirm the original remains unchanged until **Use Suggestion** is selected; also test offline behavior and function errors. `npm.cmd run build` verifies the frontend build, but does not verify provider credentials or deployment—the deployed function must be tested while signed in as a student.

## Portfolio Email Sharing

The Settings page combines the Module Introduction, Pre-Immersion, Immersion Proper, and Post-Immersion sections into one PDF, uploads it to the authenticated student's `portfolio-files` storage path, and emails a signed link that expires after 7 days. The `20261023120000_allow_portfolio_pdf_shares.sql` migration adds `application/pdf` to the bucket's allowed MIME types when the bucket has an allowlist. Email delivery requires a Resend account with a verified sender domain. Keep the Resend API key server-side; do not add it to frontend code or a `VITE_` variable.

```powershell
npx.cmd supabase secrets set RESEND_API_KEY=YOUR_RESEND_API_KEY "SHARE_EMAIL_FROM=i-WORKFOLIO <noreply@your-verified-domain.com>"
npx.cmd supabase db push
npx.cmd supabase functions deploy share-portfolio
```

The function verifies the signed-in student and that the signed link belongs to that student's portfolio storage path. Test it while signed in as a student by sharing to a Gmail inbox and confirming the combined PDF opens and the link expires after 7 days. `npm.cmd run build` does not verify Resend credentials or deployed email delivery.

## Supabase Email Verification

Student registration and verification use Supabase Auth's signup email OTP. In the Supabase Dashboard, open **Authentication → Sign In / Providers → Email** and enable the Email provider and email confirmations. Under **Authentication → Email Templates → Confirm signup**, use the OTP token in the message body, for example:

```html
<h2>Your i-WORKFOLIO verification code</h2>
<p>Enter this 6-digit code in i-WORKFOLIO:</p>
<p><strong>{{ .Token }}</strong></p>
```

Do not use only `{{ .ConfirmationURL }}` or `{{ .TokenHash }}` for the code-based screen; the app submits the six-digit token to Supabase with `verifyOtp({ type: 'signup' })`. The client also calls Supabase's `resend({ type: 'signup' })` endpoint. Keep Supabase's server-side email rate limits enabled.

For production delivery, configure a reliable custom SMTP provider in the project's Auth SMTP settings, with an authorized sender address and a domain whose SPF/DKIM records are verified with that provider. Supabase's default email service is intended for limited testing and may restrict recipients and throughput; a successful Auth API response is not proof of inbox delivery. Check Supabase Auth logs and the SMTP provider's delivery/bounce logs when messages do not arrive. Configure the app's production URL in Supabase's Auth Site URL and allowed redirect URLs as well.

This repository does not contain or control the hosted project's Email provider, confirmation, template, or SMTP settings. A production Gmail delivery test requires those Dashboard settings and access to a real test inbox; `npm.cmd run build` only verifies the frontend bundle.
