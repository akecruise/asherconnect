--
-- PostgreSQL database dump
--

\restrict Fbgjec7eLYsnyHev40LZpd4DxG8EZtnPQrVPBMMOj4nebtTcPXq9mGQuhe4lhhv

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: inbox; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA inbox;


ALTER SCHEMA inbox OWNER TO postgres;

--
-- Name: add_canned_response(uuid, text, text); Type: FUNCTION; Schema: inbox; Owner: postgres
--

CREATE FUNCTION inbox.add_canned_response(p_project_id uuid, p_shortcut text, p_content text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inbox', 'core', 'public'
    AS $$
declare v_id uuid; begin
  if core.current_user_role() not in ('marketing','manager','admin') then raise exception 'not_allowed'; end if;
  insert into inbox.canned_response(project_id,shortcut,content,created_by) values(p_project_id,p_shortcut,p_content,auth.uid())
  on conflict(project_id,shortcut) do update set content=excluded.content,is_active=true returning id into v_id;
  return v_id;
end; $$;


ALTER FUNCTION inbox.add_canned_response(p_project_id uuid, p_shortcut text, p_content text) OWNER TO postgres;

--
-- Name: agent_reply(uuid, uuid, text, text); Type: FUNCTION; Schema: inbox; Owner: postgres
--

CREATE FUNCTION inbox.agent_reply(p_conversation_id uuid, p_agent_id uuid, p_content text, p_content_type text DEFAULT 'text'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inbox', 'core', 'public'
    AS $$
declare v_message uuid; v_project uuid; v_channel text; v_role text; v_caller_role text;
begin
  v_caller_role:=current_setting('role',true); v_role:=core.current_user_role();
  if v_caller_role='authenticated' and (v_role is null or p_agent_id is distinct from auth.uid()) then raise exception 'not_allowed'; end if;
  if v_caller_role not in ('authenticated','service_role','postgres') then raise exception 'not_allowed'; end if;
  select i.project_id,i.channel into v_project,v_channel from inbox.conversation c join inbox.inbox i on i.id=c.inbox_id where c.id=p_conversation_id for update;
  if v_project is null then raise exception 'conversation_not_found'; end if;
  if v_caller_role='authenticated' and v_role not in ('manager','admin') and not exists (select 1 from inbox.conversation c where c.id=p_conversation_id and c.assignee_id=auth.uid()) then raise exception 'conversation_not_assigned'; end if;
  update inbox.conversation set status='open',bot_active=false,assignee_id=p_agent_id where id=p_conversation_id;
  insert into inbox.message(conversation_id,sender_type,sender_id,content,content_type) values(p_conversation_id,'agent',p_agent_id,p_content,p_content_type) returning id into v_message;
  insert into core.event_log(event_type,entity,entity_id,contact_id,actor_type,actor_id,project_id,channel,request_id,payload) select 'inbox.agent_replied','conversation',c.id,c.contact_id,'agent'::core.actor_type,p_agent_id,v_project,v_channel,v_message::text,jsonb_build_object('message_id',v_message) from inbox.conversation c where c.id=p_conversation_id;
  return v_message;
end; $$;


ALTER FUNCTION inbox.agent_reply(p_conversation_id uuid, p_agent_id uuid, p_content text, p_content_type text) OWNER TO postgres;

--
-- Name: assign_conversation(uuid, uuid); Type: FUNCTION; Schema: inbox; Owner: postgres
--

CREATE FUNCTION inbox.assign_conversation(p_conversation_id uuid, p_assignee_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inbox', 'core', 'public'
    AS $$
DECLARE
    v_role     text;
    v_me       uuid;
    v_current  uuid;
    v_self_claim boolean;
BEGIN
    v_role := core.current_user_role();
    v_me   := auth.uid();

    IF v_role IS NULL THEN
        RAISE EXCEPTION 'not_allowed'
            USING HINT = 'ยังไม่มีโปรไฟล์ใน core.profile — ต้องล็อกอินอย่างน้อยหนึ่งครั้ง';
    END IF;

    -- ล็อกแถวก่อนอ่านเจ้าของปัจจุบัน
    -- ถ้าไม่ล็อก เซลส์สองคนกดพร้อมกันจะเห็น assignee_id เป็น NULL ทั้งคู่
    -- แล้วคนที่เขียนทีหลังจะทับคนแรกโดยไม่มีใครรู้
    SELECT assignee_id INTO v_current
      FROM inbox.conversation WHERE id = p_conversation_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'conversation_not_found';
    END IF;

    v_self_claim := (p_assignee_id = v_me AND v_current IS NULL);

    IF v_role NOT IN ('manager','admin','senior_sales') AND NOT v_self_claim THEN
        -- แยกข้อความให้คนที่เจอรู้ว่าติดเพราะอะไร
        -- not_allowed เฉย ๆ ทำให้ต้องมาไล่โค้ดเองทุกครั้ง
        IF v_current IS NOT NULL AND v_current <> v_me THEN
            RAISE EXCEPTION 'conversation_taken'
                USING HINT = 'เคสนี้มีคนรับไปแล้ว ให้ผู้จัดการโอนให้ถ้าต้องการเปลี่ยนมือ';
        ELSIF p_assignee_id <> v_me THEN
            RAISE EXCEPTION 'not_allowed'
                USING HINT = 'เซลส์มอบหมายงานให้คนอื่นไม่ได้ รับให้ตัวเองได้เฉพาะเคสที่ยังไม่มีเจ้าของ';
        ELSE
            RAISE EXCEPTION 'not_allowed';
        END IF;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM core.profile WHERE user_id = p_assignee_id AND is_active) THEN
        RAISE EXCEPTION 'assignee_not_active';
    END IF;

    UPDATE inbox.conversation
       SET assignee_id = p_assignee_id,
           status      = CASE WHEN status = 'pending' THEN 'open' ELSE status END,
           bot_active  = false
     WHERE id = p_conversation_id;
END;
$$;


ALTER FUNCTION inbox.assign_conversation(p_conversation_id uuid, p_assignee_id uuid) OWNER TO postgres;

--
-- Name: FUNCTION assign_conversation(p_conversation_id uuid, p_assignee_id uuid); Type: COMMENT; Schema: inbox; Owner: postgres
--

COMMENT ON FUNCTION inbox.assign_conversation(p_conversation_id uuid, p_assignee_id uuid) IS 'มอบหมายบทสนทนา — ผู้จัดการ/หัวหน้ามอบหมายใครก็ได้ · เซลส์รับเคสที่ยังไม่มีเจ้าของให้ตัวเองได้';


--
-- Name: connect_api(text, jsonb); Type: FUNCTION; Schema: inbox; Owner: postgres
--

CREATE FUNCTION inbox.connect_api(p_action text, p_data jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE sql
    SET search_path TO 'pg_catalog', 'public'
    AS $$ select connect_private.api(p_action,p_data) $$;


ALTER FUNCTION inbox.connect_api(p_action text, p_data jsonb) OWNER TO postgres;

--
-- Name: connect_replay(text, jsonb); Type: FUNCTION; Schema: inbox; Owner: postgres
--

CREATE FUNCTION inbox.connect_replay(p_action text, p_data jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE sql
    SET search_path TO 'pg_catalog', 'public'
    AS $$ select connect_private.replay(p_data) $$;


ALTER FUNCTION inbox.connect_replay(p_action text, p_data jsonb) OWNER TO postgres;

--
-- Name: connect_worker(text, jsonb); Type: FUNCTION; Schema: inbox; Owner: postgres
--

CREATE FUNCTION inbox.connect_worker(p_action text, p_data jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
    LANGUAGE sql
    SET search_path TO 'pg_catalog', 'public'
    AS $$select connect_private.worker(p_action,p_data)$$;


ALTER FUNCTION inbox.connect_worker(p_action text, p_data jsonb) OWNER TO postgres;

--
-- Name: enqueue_outbound(); Type: FUNCTION; Schema: inbox; Owner: postgres
--

CREATE FUNCTION inbox.enqueue_outbound() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inbox', 'connect_private', 'core', 'public', 'pg_temp'
    AS $$
DECLARE v_has_recipient boolean;
BEGIN
    IF coalesce(current_setting('connect.replay', true), '') = 'on' THEN
        RETURN NEW;
    END IF;

    IF NEW.sender_type NOT IN ('agent','bot') THEN
        RETURN NEW;
    END IF;

    SELECT EXISTS (
        SELECT 1
          FROM inbox.conversation c
          JOIN inbox.inbox i ON i.id = c.inbox_id AND i.is_active
          JOIN core.contact_identity ci
            ON ci.contact_id = c.contact_id
           AND ci.channel = i.channel
           AND ci.account_key = i.id::text
         WHERE c.id = NEW.conversation_id
    ) INTO v_has_recipient;

    IF NOT v_has_recipient THEN
        INSERT INTO core.event_log(event_type, entity, entity_id, actor_type, project_id, channel, request_id, payload)
        SELECT 'inbox.outbound_skipped', 'message', NEW.id, 'system'::core.actor_type,
               i.project_id, i.channel, NEW.id::text,
               jsonb_build_object('reason','ไม่พบช่องทางติดต่อของลูกค้า (core.contact_identity)')
          FROM inbox.conversation c JOIN inbox.inbox i ON i.id = c.inbox_id
         WHERE c.id = NEW.conversation_id;
        RETURN NEW;
    END IF;

    INSERT INTO connect_private.delivery (message_id, status, available_at, payload)
    VALUES (NEW.id, 'pending', now(), jsonb_build_object('type','text','text',NEW.content))
    ON CONFLICT (message_id) DO NOTHING;

    RETURN NEW;
END;
$$;


ALTER FUNCTION inbox.enqueue_outbound() OWNER TO postgres;

--
-- Name: FUNCTION enqueue_outbound(); Type: COMMENT; Schema: inbox; Owner: postgres
--

COMMENT ON FUNCTION inbox.enqueue_outbound() IS 'ใส่ข้อความจากเราลงคิวขาออก — ครอบทุกทางที่เขียนลง inbox.message ไม่ใช่เฉพาะ agent_reply';


--
-- Name: mark_read(uuid); Type: FUNCTION; Schema: inbox; Owner: postgres
--

CREATE FUNCTION inbox.mark_read(p_conversation_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'inbox', 'core', 'public'
    AS $$
declare v_role text; v_caller_role text;
begin
  v_caller_role:=current_setting('role',true); v_role:=core.current_user_role();
  if v_caller_role='authenticated' and (v_role is null or not exists (select 1 from inbox.conversation c where c.id=p_conversation_id and (c.assignee_id=auth.uid() or v_role in ('manager','admin')))) then raise exception 'not_allowed'; end if;
  if v_caller_role not in ('authenticated','service_role','postgres','none') and session_user<>'postgres' then raise exception 'not_allowed'; end if;
  update inbox.conversation set unread_count=0 where id=p_conversation_id;
  update inbox.message set read_at=coalesce(read_at,now()) where conversation_id=p_conversation_id and sender_type='contact' and read_at is null;
end; $$;


ALTER FUNCTION inbox.mark_read(p_conversation_id uuid) OWNER TO postgres;

--
-- Name: set_updated_at(); Type: FUNCTION; Schema: inbox; Owner: postgres
--

CREATE FUNCTION inbox.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin new.updated_at:=now(); return new; end; $$;


ALTER FUNCTION inbox.set_updated_at() OWNER TO postgres;

--
-- Name: sync_conversation_after_message(); Type: FUNCTION; Schema: inbox; Owner: postgres
--

CREATE FUNCTION inbox.sync_conversation_after_message() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin update inbox.conversation set last_message_at=new.created_at,last_message_preview=left(new.content,240),unread_count=case when new.sender_type='contact' then unread_count+1 else unread_count end where id=new.conversation_id; return new; end; $$;


ALTER FUNCTION inbox.sync_conversation_after_message() OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: message; Type: TABLE; Schema: inbox; Owner: postgres
--

CREATE TABLE inbox.message (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    sender_type text NOT NULL,
    sender_id uuid,
    content text NOT NULL,
    content_type text DEFAULT 'text'::text NOT NULL,
    external_message_id text,
    delivered_at timestamp with time zone,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    event_type text DEFAULT 'message'::text NOT NULL,
    CONSTRAINT message_event_type_check CHECK ((event_type = ANY (ARRAY['message'::text, 'postback'::text, 'follow'::text, 'unfollow'::text, 'other'::text]))),
    CONSTRAINT message_sender_type_check CHECK ((sender_type = ANY (ARRAY['contact'::text, 'agent'::text, 'bot'::text, 'system'::text])))
);


ALTER TABLE inbox.message OWNER TO postgres;

--
-- Name: assignment_rule; Type: TABLE; Schema: inbox; Owner: postgres
--

CREATE TABLE inbox.assignment_rule (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    strategy text NOT NULL,
    keywords text[] DEFAULT '{}'::text[] NOT NULL,
    assignee_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    extra jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT assignment_rule_strategy_check CHECK ((strategy = ANY (ARRAY['round_robin'::text, 'by_project'::text, 'by_keyword'::text])))
);


ALTER TABLE inbox.assignment_rule OWNER TO postgres;

--
-- Name: canned_response; Type: TABLE; Schema: inbox; Owner: postgres
--

CREATE TABLE inbox.canned_response (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcut text NOT NULL,
    content text NOT NULL,
    project_id uuid NOT NULL,
    created_by uuid,
    is_active boolean DEFAULT true NOT NULL
);


ALTER TABLE inbox.canned_response OWNER TO postgres;

--
-- Name: conversation; Type: TABLE; Schema: inbox; Owner: postgres
--

CREATE TABLE inbox.conversation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    inbox_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    assignee_id uuid,
    bot_active boolean DEFAULT true NOT NULL,
    last_message_at timestamp with time zone,
    last_message_preview text,
    unread_count integer DEFAULT 0 NOT NULL,
    sla_due_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT conversation_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'open'::text, 'resolved'::text, 'snoozed'::text]))),
    CONSTRAINT conversation_unread_count_check CHECK ((unread_count >= 0))
);


ALTER TABLE inbox.conversation OWNER TO postgres;

--
-- Name: inbox; Type: TABLE; Schema: inbox; Owner: postgres
--

CREATE TABLE inbox.inbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    channel text NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    credentials_ref text,
    is_active boolean DEFAULT true NOT NULL,
    extra jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE inbox.inbox OWNER TO postgres;

--
-- Name: assignment_rule assignment_rule_pkey; Type: CONSTRAINT; Schema: inbox; Owner: postgres
--

ALTER TABLE ONLY inbox.assignment_rule
    ADD CONSTRAINT assignment_rule_pkey PRIMARY KEY (id);


--
-- Name: canned_response canned_response_pkey; Type: CONSTRAINT; Schema: inbox; Owner: postgres
--

ALTER TABLE ONLY inbox.canned_response
    ADD CONSTRAINT canned_response_pkey PRIMARY KEY (id);


--
-- Name: canned_response canned_response_project_id_shortcut_key; Type: CONSTRAINT; Schema: inbox; Owner: postgres
--

ALTER TABLE ONLY inbox.canned_response
    ADD CONSTRAINT canned_response_project_id_shortcut_key UNIQUE (project_id, shortcut);


--
-- Name: conversation conversation_pkey; Type: CONSTRAINT; Schema: inbox; Owner: postgres
--

ALTER TABLE ONLY inbox.conversation
    ADD CONSTRAINT conversation_pkey PRIMARY KEY (id);


--
-- Name: inbox inbox_pkey; Type: CONSTRAINT; Schema: inbox; Owner: postgres
--

ALTER TABLE ONLY inbox.inbox
    ADD CONSTRAINT inbox_pkey PRIMARY KEY (id);


--
-- Name: inbox inbox_project_id_channel_name_key; Type: CONSTRAINT; Schema: inbox; Owner: postgres
--

ALTER TABLE ONLY inbox.inbox
    ADD CONSTRAINT inbox_project_id_channel_name_key UNIQUE (project_id, channel, name);


--
-- Name: message message_conversation_id_external_message_id_key; Type: CONSTRAINT; Schema: inbox; Owner: postgres
--

ALTER TABLE ONLY inbox.message
    ADD CONSTRAINT message_conversation_id_external_message_id_key UNIQUE (conversation_id, external_message_id);


--
-- Name: message message_pkey; Type: CONSTRAINT; Schema: inbox; Owner: postgres
--

ALTER TABLE ONLY inbox.message
    ADD CONSTRAINT message_pkey PRIMARY KEY (id);


--
-- Name: conversation_contact_idx; Type: INDEX; Schema: inbox; Owner: postgres
--

CREATE INDEX conversation_contact_idx ON inbox.conversation USING btree (contact_id, last_message_at DESC);


--
-- Name: conversation_queue_idx; Type: INDEX; Schema: inbox; Owner: postgres
--

CREATE INDEX conversation_queue_idx ON inbox.conversation USING btree (status, bot_active, last_message_at);


--
-- Name: message_conversation_idx; Type: INDEX; Schema: inbox; Owner: postgres
--

CREATE INDEX message_conversation_idx ON inbox.message USING btree (conversation_id, created_at);


--
-- Name: message capture_reply; Type: TRIGGER; Schema: inbox; Owner: postgres
--

CREATE TRIGGER capture_reply AFTER INSERT ON inbox.message FOR EACH ROW WHEN ((new.sender_type = 'agent'::text)) EXECUTE FUNCTION bot.capture_reply();


--
-- Name: conversation conversation_updated_at; Type: TRIGGER; Schema: inbox; Owner: postgres
--

CREATE TRIGGER conversation_updated_at BEFORE UPDATE ON inbox.conversation FOR EACH ROW EXECUTE FUNCTION inbox.set_updated_at();


--
-- Name: message enqueue_outbound; Type: TRIGGER; Schema: inbox; Owner: postgres
--

CREATE TRIGGER enqueue_outbound AFTER INSERT ON inbox.message FOR EACH ROW EXECUTE FUNCTION inbox.enqueue_outbound();


--
-- Name: message message_sync_conversation; Type: TRIGGER; Schema: inbox; Owner: postgres
--

CREATE TRIGGER message_sync_conversation AFTER INSERT ON inbox.message FOR EACH ROW EXECUTE FUNCTION inbox.sync_conversation_after_message();


--
-- Name: assignment_rule assignment_rule_project_id_fkey; Type: FK CONSTRAINT; Schema: inbox; Owner: postgres
--

ALTER TABLE ONLY inbox.assignment_rule
    ADD CONSTRAINT assignment_rule_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.project(id);


--
-- Name: canned_response canned_response_created_by_fkey; Type: FK CONSTRAINT; Schema: inbox; Owner: postgres
--

ALTER TABLE ONLY inbox.canned_response
    ADD CONSTRAINT canned_response_created_by_fkey FOREIGN KEY (created_by) REFERENCES core."user"(id);


--
-- Name: canned_response canned_response_project_id_fkey; Type: FK CONSTRAINT; Schema: inbox; Owner: postgres
--

ALTER TABLE ONLY inbox.canned_response
    ADD CONSTRAINT canned_response_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.project(id);


--
-- Name: conversation conversation_assignee_id_fkey; Type: FK CONSTRAINT; Schema: inbox; Owner: postgres
--

ALTER TABLE ONLY inbox.conversation
    ADD CONSTRAINT conversation_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES core."user"(id);


--
-- Name: conversation conversation_contact_id_fkey; Type: FK CONSTRAINT; Schema: inbox; Owner: postgres
--

ALTER TABLE ONLY inbox.conversation
    ADD CONSTRAINT conversation_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES core.contact(id);


--
-- Name: conversation conversation_inbox_id_fkey; Type: FK CONSTRAINT; Schema: inbox; Owner: postgres
--

ALTER TABLE ONLY inbox.conversation
    ADD CONSTRAINT conversation_inbox_id_fkey FOREIGN KEY (inbox_id) REFERENCES inbox.inbox(id);


--
-- Name: inbox inbox_project_id_fkey; Type: FK CONSTRAINT; Schema: inbox; Owner: postgres
--

ALTER TABLE ONLY inbox.inbox
    ADD CONSTRAINT inbox_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.project(id);


--
-- Name: message message_conversation_id_fkey; Type: FK CONSTRAINT; Schema: inbox; Owner: postgres
--

ALTER TABLE ONLY inbox.message
    ADD CONSTRAINT message_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES inbox.conversation(id) ON DELETE CASCADE;


--
-- Name: assignment_rule assignment_manage; Type: POLICY; Schema: inbox; Owner: postgres
--

CREATE POLICY assignment_manage ON inbox.assignment_rule TO authenticated USING ((core.current_user_role() = ANY (ARRAY['manager'::text, 'admin'::text]))) WITH CHECK ((core.current_user_role() = ANY (ARRAY['manager'::text, 'admin'::text])));


--
-- Name: assignment_rule; Type: ROW SECURITY; Schema: inbox; Owner: postgres
--

ALTER TABLE inbox.assignment_rule ENABLE ROW LEVEL SECURITY;

--
-- Name: canned_response canned_manage; Type: POLICY; Schema: inbox; Owner: postgres
--

CREATE POLICY canned_manage ON inbox.canned_response TO authenticated USING ((core.current_user_role() = ANY (ARRAY['marketing'::text, 'manager'::text, 'admin'::text]))) WITH CHECK ((core.current_user_role() = ANY (ARRAY['marketing'::text, 'manager'::text, 'admin'::text])));


--
-- Name: canned_response canned_read; Type: POLICY; Schema: inbox; Owner: postgres
--

CREATE POLICY canned_read ON inbox.canned_response FOR SELECT TO authenticated USING (is_active);


--
-- Name: canned_response; Type: ROW SECURITY; Schema: inbox; Owner: postgres
--

ALTER TABLE inbox.canned_response ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation; Type: ROW SECURITY; Schema: inbox; Owner: postgres
--

ALTER TABLE inbox.conversation ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation conversation_read; Type: POLICY; Schema: inbox; Owner: postgres
--

CREATE POLICY conversation_read ON inbox.conversation FOR SELECT TO authenticated USING (connect_private.can_read(id));


--
-- Name: inbox; Type: ROW SECURITY; Schema: inbox; Owner: postgres
--

ALTER TABLE inbox.inbox ENABLE ROW LEVEL SECURITY;

--
-- Name: inbox inbox_read; Type: POLICY; Schema: inbox; Owner: postgres
--

CREATE POLICY inbox_read ON inbox.inbox FOR SELECT TO authenticated USING (((core.current_user_role() = ANY (ARRAY['manager'::text, 'admin'::text, 'marketing'::text])) OR is_active));


--
-- Name: message; Type: ROW SECURITY; Schema: inbox; Owner: postgres
--

ALTER TABLE inbox.message ENABLE ROW LEVEL SECURITY;

--
-- Name: message message_read; Type: POLICY; Schema: inbox; Owner: postgres
--

CREATE POLICY message_read ON inbox.message FOR SELECT TO authenticated USING (connect_private.can_read(conversation_id));


--
-- Name: SCHEMA inbox; Type: ACL; Schema: -; Owner: postgres
--

GRANT USAGE ON SCHEMA inbox TO service_role;
GRANT USAGE ON SCHEMA inbox TO authenticated;


--
-- Name: FUNCTION add_canned_response(p_project_id uuid, p_shortcut text, p_content text); Type: ACL; Schema: inbox; Owner: postgres
--

REVOKE ALL ON FUNCTION inbox.add_canned_response(p_project_id uuid, p_shortcut text, p_content text) FROM PUBLIC;
GRANT ALL ON FUNCTION inbox.add_canned_response(p_project_id uuid, p_shortcut text, p_content text) TO authenticated;
GRANT ALL ON FUNCTION inbox.add_canned_response(p_project_id uuid, p_shortcut text, p_content text) TO service_role;


--
-- Name: FUNCTION agent_reply(p_conversation_id uuid, p_agent_id uuid, p_content text, p_content_type text); Type: ACL; Schema: inbox; Owner: postgres
--

REVOKE ALL ON FUNCTION inbox.agent_reply(p_conversation_id uuid, p_agent_id uuid, p_content text, p_content_type text) FROM PUBLIC;
GRANT ALL ON FUNCTION inbox.agent_reply(p_conversation_id uuid, p_agent_id uuid, p_content text, p_content_type text) TO service_role;
GRANT ALL ON FUNCTION inbox.agent_reply(p_conversation_id uuid, p_agent_id uuid, p_content text, p_content_type text) TO authenticated;


--
-- Name: FUNCTION assign_conversation(p_conversation_id uuid, p_assignee_id uuid); Type: ACL; Schema: inbox; Owner: postgres
--

REVOKE ALL ON FUNCTION inbox.assign_conversation(p_conversation_id uuid, p_assignee_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION inbox.assign_conversation(p_conversation_id uuid, p_assignee_id uuid) TO authenticated;
GRANT ALL ON FUNCTION inbox.assign_conversation(p_conversation_id uuid, p_assignee_id uuid) TO service_role;


--
-- Name: FUNCTION connect_api(p_action text, p_data jsonb); Type: ACL; Schema: inbox; Owner: postgres
--

REVOKE ALL ON FUNCTION inbox.connect_api(p_action text, p_data jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION inbox.connect_api(p_action text, p_data jsonb) TO authenticated;


--
-- Name: FUNCTION connect_replay(p_action text, p_data jsonb); Type: ACL; Schema: inbox; Owner: postgres
--

REVOKE ALL ON FUNCTION inbox.connect_replay(p_action text, p_data jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION inbox.connect_replay(p_action text, p_data jsonb) TO service_role;


--
-- Name: FUNCTION connect_worker(p_action text, p_data jsonb); Type: ACL; Schema: inbox; Owner: postgres
--

REVOKE ALL ON FUNCTION inbox.connect_worker(p_action text, p_data jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION inbox.connect_worker(p_action text, p_data jsonb) TO service_role;


--
-- Name: FUNCTION enqueue_outbound(); Type: ACL; Schema: inbox; Owner: postgres
--

REVOKE ALL ON FUNCTION inbox.enqueue_outbound() FROM PUBLIC;


--
-- Name: FUNCTION mark_read(p_conversation_id uuid); Type: ACL; Schema: inbox; Owner: postgres
--

REVOKE ALL ON FUNCTION inbox.mark_read(p_conversation_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION inbox.mark_read(p_conversation_id uuid) TO authenticated;
GRANT ALL ON FUNCTION inbox.mark_read(p_conversation_id uuid) TO service_role;


--
-- Name: TABLE message; Type: ACL; Schema: inbox; Owner: postgres
--

GRANT ALL ON TABLE inbox.message TO service_role;
GRANT SELECT ON TABLE inbox.message TO authenticated;


--
-- Name: TABLE assignment_rule; Type: ACL; Schema: inbox; Owner: postgres
--

GRANT ALL ON TABLE inbox.assignment_rule TO service_role;
GRANT SELECT ON TABLE inbox.assignment_rule TO authenticated;


--
-- Name: TABLE canned_response; Type: ACL; Schema: inbox; Owner: postgres
--

GRANT ALL ON TABLE inbox.canned_response TO service_role;
GRANT SELECT ON TABLE inbox.canned_response TO authenticated;


--
-- Name: TABLE conversation; Type: ACL; Schema: inbox; Owner: postgres
--

GRANT ALL ON TABLE inbox.conversation TO service_role;
GRANT SELECT ON TABLE inbox.conversation TO authenticated;


--
-- Name: TABLE inbox; Type: ACL; Schema: inbox; Owner: postgres
--

GRANT ALL ON TABLE inbox.inbox TO service_role;


--
-- Name: COLUMN inbox.id; Type: ACL; Schema: inbox; Owner: postgres
--

GRANT SELECT(id) ON TABLE inbox.inbox TO authenticated;


--
-- Name: COLUMN inbox.channel; Type: ACL; Schema: inbox; Owner: postgres
--

GRANT SELECT(channel) ON TABLE inbox.inbox TO authenticated;


--
-- Name: COLUMN inbox.project_id; Type: ACL; Schema: inbox; Owner: postgres
--

GRANT SELECT(project_id) ON TABLE inbox.inbox TO authenticated;


--
-- Name: COLUMN inbox.name; Type: ACL; Schema: inbox; Owner: postgres
--

GRANT SELECT(name) ON TABLE inbox.inbox TO authenticated;


--
-- Name: COLUMN inbox.is_active; Type: ACL; Schema: inbox; Owner: postgres
--

GRANT SELECT(is_active) ON TABLE inbox.inbox TO authenticated;


--
-- Name: COLUMN inbox.extra; Type: ACL; Schema: inbox; Owner: postgres
--

GRANT SELECT(extra) ON TABLE inbox.inbox TO authenticated;


--
-- Name: COLUMN inbox.created_at; Type: ACL; Schema: inbox; Owner: postgres
--

GRANT SELECT(created_at) ON TABLE inbox.inbox TO authenticated;


--
-- PostgreSQL database dump complete
--

\unrestrict Fbgjec7eLYsnyHev40LZpd4DxG8EZtnPQrVPBMMOj4nebtTcPXq9mGQuhe4lhhv

