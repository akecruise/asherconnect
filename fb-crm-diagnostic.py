"""Read-only Meta diagnostics. Python standard library only; no CRM writes."""
import argparse
import json
import os
import re
import sys
from collections import Counter
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def graph_get(path, token, params, version):
    url = f"https://graph.facebook.com/{version}/{path}?{urlencode(params)}"
    req = Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urlopen(req, timeout=15) as reply:
            return json.load(reply)
    except HTTPError as error:
        try:
            body = json.load(error).get("error", {})
        except (ValueError, AttributeError):
            body = {}
        # Never include URLs, tokens, Graph messages, or profile content.
        raise RuntimeError(f"Graph HTTP {error.code}; code={body.get('code')}; subcode={body.get('error_subcode')}") from None
    except (URLError, TimeoutError, ValueError):
        raise RuntimeError("Graph request failed: network, timeout, or invalid JSON") from None


def check_api(env, get=graph_get):
    required = ("FB_PAGE_TOKEN", "FB_APP_ID", "FB_APP_TOKEN")
    missing = [key for key in required if not env.get(key) or env[key].strip() == "..."]
    if missing:
        raise ValueError("Set real values for: " + ", ".join(missing))
    version = env.get("FB_GRAPH_VERSION", "v23.0")
    if not re.fullmatch(r"v\d+\.\d+", version):
        raise ValueError("FB_GRAPH_VERSION must look like v23.0")
    debug = get("debug_token", env["FB_APP_TOKEN"], {"input_token": env["FB_PAGE_TOKEN"]}, version).get("data", {})
    valid = debug.get("is_valid") is True
    app_matches = str(debug.get("app_id", "")) == env["FB_APP_ID"]
    scopes = set(debug.get("scopes") or [])
    page_ok = False
    if valid and app_matches:
        page_ok = bool(get("me", env["FB_PAGE_TOKEN"], {"fields": "id"}, version).get("id"))
    return {
        "token_valid": valid,
        "app_matches": app_matches,
        "page_identity_lookup_ok": page_ok,
        "permissions_present": {p: p in scopes for p in (
            "pages_messaging", "pages_read_engagement", "pages_manage_metadata", "leads_retrieval")},
        "note": "Scope presence alone does not prove Page/lead access. No profile or lead retrieval was tested.",
    }


def analyze_log(path):
    counts = Counter(records=0, malformed=0, unrecognized=0, messenger_messages=0,
                     echoes=0, postbacks=0, referrals=0, leadgen_events=0,
                     leadgen_missing_id=0, duplicate_message_ids=0, missing_sender=0)
    seen = set()
    with open(path, encoding="utf-8-sig") as source:
        for line in source:
            if not line.strip():
                continue
            counts["records"] += 1
            try:
                record = json.loads(line)
                if not isinstance(record, dict):
                    raise ValueError()
                body = record.get("payload", record.get("body", record))
                if isinstance(body, str):
                    body = json.loads(body)
                if not isinstance(body, dict) or not isinstance(body.get("entry"), list):
                    counts["unrecognized"] += 1
                    continue
                for entry in body["entry"]:
                    if not isinstance(entry, dict):
                        raise ValueError()
                    for change in entry.get("changes", []):
                        if change.get("field") == "leadgen":
                            counts["leadgen_events"] += 1
                            if not (change.get("value") or {}).get("leadgen_id"):
                                counts["leadgen_missing_id"] += 1
                    for event in entry.get("messaging", []) + entry.get("standby", []):
                        message = event.get("message") or {}
                        if message:
                            counts["echoes" if message.get("is_echo") else "messenger_messages"] += 1
                            mid = message.get("mid")
                            if mid:
                                key = (str(entry.get("id")), str(mid))
                                counts["duplicate_message_ids"] += key in seen
                                seen.add(key)
                            if not (event.get("sender") or {}).get("id"):
                                counts["missing_sender"] += 1
                        counts["postbacks"] += bool(event.get("postback"))
                        counts["referrals"] += bool(event.get("referral") or message.get("referral") or (event.get("postback") or {}).get("referral"))
            except (ValueError, TypeError, AttributeError):
                counts["malformed"] += 1
    return {"counts": dict(counts), "note": "Counts only; duplicate delivery does not prove duplicate CRM records. Signatures and CRM writes were not verified."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("check-api")
    logs = commands.add_parser("analyze-log")
    logs.add_argument("--file", required=True)
    args = parser.parse_args()
    try:
        result = check_api(os.environ) if args.command == "check-api" else analyze_log(args.file)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if args.command == "check-api":
            return 0 if all(result[k] for k in ("token_valid", "app_matches", "page_identity_lookup_ok")) else 1
        return 1 if result["counts"]["malformed"] or result["counts"]["unrecognized"] else 0
    except OSError:
        print("Cannot read the log file; check its path and permissions.", file=sys.stderr)
    except (ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
