# Post-quote Umrah edit routing fix

This update keeps the Umrah session active after a quotation and routes later customer messages to the Umrah edit handler before the generic `Tours Sales Menu` flow.

## Fixed behavior

After the first quotation, these messages no longer restart the welcome menu:

- Change Makkah hotel
- Change Madinah hotel
- Show Executive hotels
- Increase adults to 3
- Reduce nights to 10
- Change date
- Add or remove Ziyarat
- Change transport or vehicle
- Send latest itinerary

## Files

Modified:

- `src/lib/umrah-planner/follow-up.ts`

Add/apply:

- `WEBHOOK_POST_QUOTE_PRIORITY.patch`
- `supabase/migrations/046_keep_umrah_session_after_quote.sql`

The ZIP also includes the existing AI intake and quotation files so it can be overlaid on the previous release.

## Installation

From the CRM repository root:

```bash
git apply WEBHOOK_POST_QUOTE_PRIORITY.patch
```

Copy the included `src` files over the matching paths.

Run in Supabase SQL Editor:

```text
supabase/migrations/046_keep_umrah_session_after_quote.sql
```

Then test:

```bash
npm run build
```

## Vercel

Keep:

```env
UMRAH_PORTAL_API_URL=https://toursinpakistan.com/umrah_designer/api/?action=storage
```

## Expected test

1. Generate a quotation.
2. Send `Can you change hotel in Makkah?`
3. The CRM should show the live Makkah hotel list.
4. Selecting a hotel should recalculate and send the full updated quotation.
