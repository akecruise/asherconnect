-- Periodic, idempotent backfill for outbound human messages whose sender_id
-- was captured before responder attribution was installed.
-- This is intentionally additive: it never changes rows that already have a
-- responder snapshot and it never infers a responder from message text.

CREATE OR REPLACE FUNCTION inbox.backfill_responder_attribution(
  p_batch_size integer DEFAULT 500
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, inbox, core, connect_private, public
AS $$
DECLARE
  v_updated integer := 0;
BEGIN
  IF p_batch_size IS NULL OR p_batch_size < 1 OR p_batch_size > 5000 THEN
    RAISE EXCEPTION 'p_batch_size must be between 1 and 5000';
  END IF;

  -- A cron tick that overlaps a slow previous tick exits cleanly.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('asher-connect.responder-backfill', 0)) THEN
    RETURN 0;
  END IF;

  WITH candidates AS (
    SELECT m.id
      FROM inbox.message m
      JOIN core.profile p ON p.user_id = m.sender_id AND p.is_active
     WHERE m.sender_type = 'agent'
       AND m.sender_id IS NOT NULL
       AND m.responder_user_id IS NULL
     ORDER BY m.created_at, m.id
     LIMIT p_batch_size
  )
  UPDATE inbox.message m
     SET responder_user_id = m.sender_id,
         responder_display_name = COALESCE(
           NULLIF(BTRIM(p.display_name), ''),
           NULLIF(BTRIM(u.email), '')
         ),
         sent_at = COALESCE(m.sent_at, m.created_at)
    FROM candidates c
    JOIN core.profile p ON p.user_id = m.sender_id AND p.is_active
    LEFT JOIN core."user" u ON u.id = m.sender_id
   WHERE m.id = c.id
     AND m.responder_user_id IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END
$$;

ALTER FUNCTION inbox.backfill_responder_attribution(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION inbox.backfill_responder_attribution(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION inbox.backfill_responder_attribution(integer) TO postgres;

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Re-running this migration replaces the same job instead of creating copies.
SELECT cron.unschedule(jobid)
  FROM cron.job
 WHERE jobname = 'responder-attribution-backfill';

SELECT cron.schedule(
  'responder-attribution-backfill',
  '*/10 * * * *',
  $cron$SELECT inbox.backfill_responder_attribution(500)$cron$
);

NOTIFY pgrst, 'reload schema';
