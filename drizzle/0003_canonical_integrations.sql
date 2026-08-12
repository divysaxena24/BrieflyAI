-- Canonicalize integrations before enforcing one row per user/platform.
-- Keep a connected row when present; otherwise keep the most recently updated row.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, platform
      ORDER BY
        CASE WHEN status = 'connected' THEN 0 ELSE 1 END,
        updated_at DESC NULLS LAST,
        created_at DESC,
        id DESC
    ) AS row_number
  FROM integrations
)
DELETE FROM integrations AS stale
USING ranked
WHERE stale.id = ranked.id
  AND ranked.row_number > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_integrations_user_platform"
  ON integrations (user_id, platform);
