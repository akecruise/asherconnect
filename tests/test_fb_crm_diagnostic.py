import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("diagnostic", Path(__file__).resolve().parents[1] / "fb-crm-diagnostic.py")
diagnostic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diagnostic)


class DiagnosticTests(unittest.TestCase):
    def test_placeholder_credentials_never_call_api(self):
        with self.assertRaises(ValueError):
            diagnostic.check_api({"FB_PAGE_TOKEN": "..."}, lambda *a: self.fail("Network called"))

    def test_wrong_app_does_not_query_page(self):
        calls = []
        def get(*args):
            calls.append(args[0])
            return {"data": {"is_valid": True, "app_id": "different"}}
        out = diagnostic.check_api({"FB_PAGE_TOKEN": "secret", "FB_APP_TOKEN": "appsecret", "FB_APP_ID": "expected"}, get)
        self.assertFalse(out["app_matches"])
        self.assertEqual(calls, ["debug_token"])
        self.assertNotIn("secret", json.dumps(out))

    def test_mixed_events_and_redaction(self):
        event = {"sender": {"id": "private-user"}, "message": {"mid": "m1", "text": "private-name 0812345678"}}
        body = {"entry": [{"id": "page", "messaging": [event, event], "changes": [{"field": "leadgen", "value": {"leadgen_id": "private-lead"}}]}]}
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / "webhook.jsonl"
            file.write_text(json.dumps({"payload": body}) + '\ninvalid\n', encoding="utf-8")
            result = diagnostic.analyze_log(file)
        self.assertEqual(result["counts"]["messenger_messages"], 2)
        self.assertEqual(result["counts"]["duplicate_message_ids"], 1)
        self.assertEqual(result["counts"]["leadgen_events"], 1)
        self.assertEqual(result["counts"]["malformed"], 1)
        self.assertNotIn("private-", json.dumps(result))
        self.assertNotIn("0812345678", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
