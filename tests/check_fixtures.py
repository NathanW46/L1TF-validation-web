#!/usr/bin/env python3
"""Run both YAML-subset parsers (contrib/check_analysis.py and lib/yaml.php)
on every tests/yaml_fixtures/*.yaml and compare with the expected .json/.err.

    python3 tests/check_fixtures.py            # both parsers (needs php)
    python3 tests/check_fixtures.py --no-php   # Python parser only
"""

import glob
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "public", "contrib"))
from check_analysis import YamlError, parse_yaml  # noqa: E402


def python_result(path):
    try:
        with open(path, encoding="utf-8") as f:
            return ("ok", parse_yaml(f.read()))
    except YamlError as e:
        return ("err", str(e))


def php_result(path):
    out = subprocess.run(["php", os.path.join(HERE, "php_parse.php"), path],
                         capture_output=True, text=True, check=True).stdout.strip()
    if out.startswith("ERR "):
        return ("err", out[4:])
    return ("ok", json.loads(out))


def expected(path):
    stem = path[:-5]
    if os.path.exists(stem + ".json"):
        with open(stem + ".json", encoding="utf-8") as f:
            return ("ok", json.load(f))
    with open(stem + ".err", encoding="utf-8") as f:
        return ("err", f.read().strip())


def main():
    use_php = "--no-php" not in sys.argv
    if use_php and not shutil.which("php"):
        print("php not found; run with --no-php to test only the Python parser")
        return 1
    parsers = [("python", python_result)] + ([("php", php_result)] if use_php else [])
    fails = 0
    fixtures = sorted(glob.glob(os.path.join(HERE, "yaml_fixtures", "*.yaml")))
    for path in fixtures:
        want = expected(path)
        for name, fn in parsers:
            got = fn(path)
            if got != want:
                fails += 1
                print(f"FAIL [{name}] {os.path.basename(path)}\n  want {want}\n  got  {got}")
    print(f"{len(fixtures)} fixtures x {len(parsers)} parser(s): "
          + ("all OK" if not fails else f"{fails} failure(s)"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
