# Monthly Fee Scheduling

This project includes a Supabase Edge Function and a GitHub Actions workflow to automatically generate monthly membership fee records for all active students.

## Components

- Supabase Edge Function endpoint:
  - Path: `supabase/functions/generate-monthly-fees/index.ts`
  - URL format (after deploy): `https://<PROJECT_REF>.functions.supabase.co/generate-monthly-fees`
  - JWT verification: disabled via `supabase/config.toml` to allow cron access

- GitHub Actions workflow (cron):
  - Path: `.github/workflows/generate-monthly-fees.yml`
  - Schedule: runs at 03:00 UTC on the 1st of every month
  - It POSTs to the Edge Function with a shared secret header `X-FEE-SECRET`

## Environment Variables

Set these variables in Supabase Project (Function environment variables):
- `SUPABASE_URL` (automatically provided by Supabase in most setups)
- `SUPABASE_SERVICE_ROLE_KEY` (Service Role Key, keep secret)
- `FEE_TRIGGER_SECRET` (any strong random string, must match GitHub secret below)

Set these GitHub Repository Secrets:
- `SUPABASE_FUNCTION_URL` = `https://<PROJECT_REF>.functions.supabase.co/generate-monthly-fees`
- `FEE_TRIGGER_SECRET` = same value as in Supabase `FEE_TRIGGER_SECRET`

## Deployment

1. Install Supabase CLI and login
2. Deploy the Edge Function:
   ```bash
   supabase functions deploy generate-monthly-fees --project-ref <PROJECT_REF>
   ```
3. Set function environment variables in Supabase Dashboard:
   - Project Settings → Functions → Add `SUPABASE_SERVICE_ROLE_KEY`, `FEE_TRIGGER_SECRET`
4. Confirm `supabase/config.toml` includes:
   ```toml
   [functions.generate-monthly-fees]
   verify_jwt = false
   ```
5. Push the repo to GitHub. The workflow `.github/workflows/generate-monthly-fees.yml` will be active.
6. Set the GitHub Secrets mentioned above.

## Manual Trigger

You can trigger fee generation on demand:
- From GitHub Actions → `Generate Monthly Fees` → `Run workflow`
- Or directly via curl:
  ```bash
  curl -X POST "$SUPABASE_FUNCTION_URL" \
    -H "Content-Type: application/json" \
    -H "X-FEE-SECRET: $FEE_TRIGGER_SECRET" \
    --data '{}'
  ```

## Notes

- The function prevents duplicates by checking existing `payments.payment_period` for the current `YYYY-MM` and skipping already created student records.
- Calculates fee using `sport_branches.monthly_fee` (fallback `fee`, default 500) and applies `students.discount_rate`.
- Inserts are batched to avoid payload limits.
