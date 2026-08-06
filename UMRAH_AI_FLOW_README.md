# Flow → Dedicated Umrah AI Session

## Result

- `Hi` starts the existing Tours Sales Menu flow.
- Pakistan Tour continues through the existing fixed Pakistan flow.
- Umrah opens `um_ai_intake` and sends the required starting message.
- Every Umrah message is merged into the same active `flow_runs.vars` session.
- The system asks only for missing fields.
- Natural dates are normalized.
- When all required details are available, the customer receives a verification summary.
- The quote is generated only after `Confirm`.
- Selective transport opens the live transport-sector list.
- Quote calculation reads current catalog data through `UMRAH_PORTAL_API_URL`; it does not open the portal UI.
- After quotation, the existing follow-up handler can update and recalculate fields.

## Required Vercel variable

```env
UMRAH_PORTAL_API_URL=https://toursinpakistan.com/umrah_designer/api/?action=storage
```

## Install

1. Copy the included `src` files into the same paths in the CRM.
2. Run in Supabase SQL Editor:

```text
supabase/migrations/045_flow_to_umrah_ai_session.sql
```

3. Reset old active test runs:

```sql
UPDATE flow_runs
SET status = 'failed', ended_at = NOW(), end_reason = 'reset_for_umrah_ai_intake'
WHERE flow_id = 'c51b284b-4575-4fe3-9d3f-ae2c839f59b2'
  AND status = 'active';
```

4. Build and deploy:

```bash
npm run build
git add .
git commit -m "Route Umrah flow to dedicated AI intake"
git push origin main
```

## Rollback

The previous step-by-step nodes were not deleted. To restore them:

```sql
UPDATE flow_nodes
SET config = jsonb_set(
  config,
  '{buttons}',
  (
    SELECT jsonb_agg(
      CASE
        WHEN button->>'reply_id' = 'umrah_quote'
          THEN jsonb_set(button, '{next_node_key}', '"um_name"'::jsonb)
        ELSE button
      END
    )
    FROM jsonb_array_elements(config->'buttons') AS button
  )
)
WHERE flow_id = 'c51b284b-4575-4fe3-9d3f-ae2c839f59b2'
  AND node_key = 'welcome_menu';
```

## Important behavior

If the customer asks a genuine question while the Umrah intake is active and no structured value is extracted, the flow remains suspended and the normal AI responder may answer. The next message continues the same Umrah session.
