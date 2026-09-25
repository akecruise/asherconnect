-- The Connect worker calls this final alert-state check with the service role.
-- Keep authenticated access for the existing command boundary and explicitly
-- allow the worker; the original monitor migration granted only authenticated.

begin;

grant execute on function inbox.reply_alert_current(uuid) to service_role;

notify pgrst, 'reload schema';

commit;
