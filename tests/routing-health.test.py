"""Run on Linux: python3 tests/routing-health.test.py [path-to-health-script]."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(sys.argv.pop(1) if len(sys.argv) > 1 else "deploy/vpnbot-route-health").read_text()


class RoutingHealthTest(unittest.TestCase):
    def test_route_selection_and_fallback(self):
        for configured, available, initial_rule in [
            (False, True, False), (True, True, False), (True, True, True),
            (True, False, True), (True, False, False),
        ]:
            with self.subTest(configured=configured, available=available, initial_rule=initial_rule):
                with tempfile.TemporaryDirectory(prefix="vpnbot-health-test-") as directory:
                    root = Path(directory)
                    config = root / "routing.defaults"
                    interface, peer = ("tun99", "10.211.0.2") if configured else ("wg-vpnbot", "10.210.0.2")
                    if configured:
                        config.write_text(f"VPN_EGRESS_INTERFACE={interface}\nVPN_EGRESS_PEER={peer}\n")
                    script = root / "health"
                    script.write_text(SOURCE.replace("/etc/default/vpnbot-routing", str(config)))
                    state_path = root / "state.json"
                    state_path.write_text(json.dumps({"rule": initial_rule, "route": "old" if initial_rule else None}))
                    mock = '''#!/usr/bin/env python3
import json, os, pathlib, sys
p = pathlib.Path(os.environ["TEST_STATE"])
s = json.loads(p.read_text())
a = sys.argv[1:]
if pathlib.Path(sys.argv[0]).name == "ping":
    assert a[a.index("-I") + 1] == os.environ["TEST_INTERFACE"]
    assert a[-1] == os.environ["TEST_PEER"]
    sys.exit(0 if os.environ["TEST_AVAILABLE"] == "1" else 1)
if a[:2] == ["link", "show"]:
    assert a[2] == os.environ["TEST_INTERFACE"]
elif a == ["-4", "rule", "show"]:
    if s["rule"]: print("10210: from all fwmark 0x210 lookup 210")
elif a[:3] == ["-4", "rule", "add"]:
    assert not s["rule"], "duplicate policy rule"
    s["rule"] = True
elif a[:3] == ["-4", "rule", "del"]:
    s["rule"] = False
elif a[:3] == ["-4", "route", "replace"]:
    assert a[3:] == ["table", "210", "default", "dev", os.environ["TEST_INTERFACE"]]
    s["route"] = a[-1]
elif a == ["-4", "route", "flush", "table", "210"]:
    s["route"] = None
else:
    raise AssertionError(a)
p.write_text(json.dumps(s))
'''
                    for name in ("ip", "ping"):
                        target = root / name
                        target.write_text(mock)
                        target.chmod(0o755)
                    env = dict(os.environ, PATH=f"{root}:{os.environ['PATH']}",
                               TEST_STATE=str(state_path), TEST_INTERFACE=interface,
                               TEST_PEER=peer, TEST_AVAILABLE="1" if available else "0")
                    subprocess.run(["bash", str(script)], env=env, check=True)
                    # A second run must keep exactly the same rule and route.
                    subprocess.run(["bash", str(script)], env=env, check=True)
                    state = json.loads(state_path.read_text())
                    self.assertEqual(state["rule"], available)
                    self.assertEqual(state["route"], interface if available else None)


if __name__ == "__main__":
    unittest.main()
