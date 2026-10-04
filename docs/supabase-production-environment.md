# AI Orchestra Supabase production environment

Project URL: https://bpkrqfohfgdchkgxideb.supabase.co

Required runtime variables:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://bpkrqfohfgdchkgxideb.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<current publishable key>
SUPABASE_URL=https://bpkrqfohfgdchkgxideb.supabase.co
SUPABASE_SECRET_KEY=<set only in the deployment secret store>
```

Optional AI Orchestra runtime variables remain defined in `.env.example`.

Security rules:
- Never commit `SUPABASE_SECRET_KEY`, `OPENAI_API_KEY`, `INTERNAL_WORKER_SECRET`, or `CREDENTIAL_MASTER_KEY_V1`.
- Use the publishable key for browser/server SSR clients.
- Use the secret key only in `lib/supabase/admin.ts` server-side code.
- The deleted Inbox9 project `dsneocuorwxrifhjgnxy` is not a valid source for any environment variable.
- Session cookies are refreshed through the root Next.js 16 `proxy.ts` using verified Supabase claims.
