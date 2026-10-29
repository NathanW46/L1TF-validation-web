#!/usr/bin/env bash
# Run all tests: both YAML parsers against the fixtures, then smoke tests of
# api.php through PHP's built-in server on a temporary copy of public/ with
# some deliberately broken analyses added. Needs python3, php and curl.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PORT="${PORT:-8765}"
fails=0

python3 "$HERE/check_fixtures.py" || fails=$((fails + 1))
python3 "$HERE/test_make_analysis_yaml.py" | tail -1 | grep -q "ALL OK" \
  && echo "make_analysis_yaml.py: all OK" \
  || { echo "FAIL make_analysis_yaml.py (run tests/test_make_analysis_yaml.py for details)"; fails=$((fails + 1)); }

if ! command -v php >/dev/null; then
  echo "php not found: skipping API tests"
  exit 1
fi
for f in "$ROOT"/public/api.php "$ROOT"/public/lib/*.php "$ROOT"/dev_router.php; do
  php -l "$f" >/dev/null || { echo "FAIL php -l $f"; fails=$((fails + 1)); }
done

TMP="$(mktemp -d)"
trap 'kill $SERVER 2>/dev/null; wait $SERVER 2>/dev/null; rm -rf "$TMP"' EXIT
cp -R "$ROOT/public" "$TMP/public"
A="$TMP/public/analyses"
# Start from an empty analyses/ (keeping its .htaccess), so the tests don't
# depend on whatever analyses happen to be in the local copy.
find "$A" -mindepth 1 -maxdepth 1 ! -name .htaccess -exec rm -rf {} +

# Tiny but valid plot files.
PNG="$TMP/p.png"; PDF="$TMP/p.pdf"
python3 - "$PNG" "$PDF" <<'PY'
import base64, sys
open(sys.argv[1], "wb").write(base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="))
open(sys.argv[2], "wb").write(b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 150]>>endobj\n"
    b"trailer<</Root 1 0 R>>\n%%EOF\n")
PY

# full-example: YAML, notes, PDF+PNG and PDF-only plots in subfolders, other files.
F="$A/full-example"
mkdir -p "$F/efficiency" "$F/resolution"
cat > "$F/analysis.yaml" <<'YAML'
title: Full example
author: Tester
date: 2026-10-28
tags: [example]
inputs:
  - label: SIM Disp.
    algo: HYBRID_DISPLACED
    mc_sample: SUSY 200PU
    mc_path: /RelValDisplacedSUSY_14TeV/X-v1/GEN-SIM-DIGI-RAW
    events: 1000
selection:
  eta: "< 2.4"
  pt: "> 2 GeV"
YAML
printf '## Notes\n\nSome *notes*.\n' > "$F/notes.md"
for p in eff_vs_eta eff_vs_pt; do cp "$PNG" "$F/efficiency/$p.png"; cp "$PDF" "$F/efficiency/$p.pdf"; done
cp "$PDF" "$F/resolution/d0_res_vs_eta.pdf"
printf 'root' > "$F/data.root"; printf 'root' > "$F/resolution.root"

# bare-example: just PNGs, no analysis.yaml.
mkdir -p "$A/bare-example"
for p in eta_efficiency pt_efficiency plot1; do cp "$PNG" "$A/bare-example/$p.png"; done

# Deliberately broken or risky analyses.
mkdir -p "$A/broken-yaml" "$A/bad name" "$A/.hidden" "$A/sneaky"
printf 'title: [oops\n' > "$A/broken-yaml/analysis.yaml"
cp "$PNG" "$A/broken-yaml/eta_efficiency.png"
cp "$PNG" "$A/bad name/eta_efficiency.png"
printf '<?php echo "EXECUTED"; ?>\n' > "$A/sneaky/evil.php"
printf 'print("hi")\n' > "$A/sneaky/script.py"
printf '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n' > "$A/sneaky/plot.svg"
cp "$PNG" "$A/sneaky/pt.png"
ln -s / "$A/sneaky/rootlink"
ln -s "$A/sneaky" "$A/linked"

php -S "127.0.0.1:$PORT" -t "$TMP/public" "$ROOT/dev_router.php" >"$TMP/server.log" 2>&1 &
SERVER=$!
for _ in $(seq 50); do curl -s "http://127.0.0.1:$PORT/" >/dev/null && break; sleep 0.1; done

U="http://127.0.0.1:$PORT"
check() {   # check <description> <python condition on `d` (parsed JSON) / `s` (status) / `t` (body)> <url>
  local desc="$1" cond="$2" url="$3"
  local body status
  body="$(curl -s -w '\n%{http_code}' "$url")"
  status="${body##*$'\n'}"; body="${body%$'\n'*}"
  if BODY="$body" STATUS="$status" python3 -c "
import json, os, sys
t = os.environ['BODY']; s = int(os.environ['STATUS'])
try: d = json.loads(t)
except Exception: d = None
sys.exit(0 if ($cond) else 1)"; then
    echo "ok   $desc"
  else
    echo "FAIL $desc  (HTTP $status) ${body:0:200}"
    fails=$((fails + 1))
  fi
}

check "list returns analyses" \
  "s == 200 and {a['id'] for a in d['analyses']} >= {'full-example', 'bare-example', 'broken-yaml'}" \
  "$U/api.php?action=list"
check "list: hidden and symlinked folders skipped" \
  "not any(a['id'] in ('.hidden', 'linked') for a in d['analyses'])" "$U/api.php?action=list"
check "list: broken YAML listed with its error" \
  "[a['error'] for a in d['analyses'] if a['id'] == 'broken-yaml'] == ['analysis.yaml, line 1: unterminated list \\'[\\'']" \
  "$U/api.php?action=list"
check "list: bad folder name listed with error, no id" \
  "any(a['id'] is None and a['title'] == 'bad name' and a['error'] for a in d['analyses'])" "$U/api.php?action=list"
check "list: defaults without YAML" \
  "[(a['title'], a['author'], a['n_plots']) for a in d['analyses'] if a['id'] == 'bare-example'] == [('bare-example', 'Unknown', 3)]" \
  "$U/api.php?action=list"
check "get: metadata, notes, plots grouped by stem, files" \
  "s == 200 and d['title'] == 'Full example' and d['notes']['markdown'] and len(d['plots']) == 3 \
   and sum(len(p['formats']) == 2 for p in d['plots']) == 2 \
   and sorted(p['dir'] for p in d['plots']) == ['efficiency', 'efficiency', 'resolution'] \
   and sorted(f['path'] for f in d['files']) == ['data.root', 'resolution.root'] \
   and d['meta']['inputs'][0]['label'] == 'SIM Disp.' and d['meta']['inputs'][0]['mc_sample'] == 'SUSY 200PU' and d['meta']['selection']['pt'] == '> 2 GeV'" \
  "$U/api.php?action=get&id=full-example"
check "get: plot urls resolve" \
  "s == 200 and all(u.startswith('analyses/full-example/') for p in d['plots'] for u in p['formats'].values())" \
  "$U/api.php?action=get&id=full-example"
check "get: symlink inside analysis not followed, SVG ignored" \
  "s == 200 and [p['path'] for p in d['plots']] == ['pt'] and [f['path'] for f in d['files']] == ['evil.php', 'script.py']" \
  "$U/api.php?action=get&id=sneaky"
check "get: path traversal rejected" "s == 404" "$U/api.php?action=get&id=../lib"
check "get: dot-dot rejected" "s == 404" "$U/api.php?action=get&id=.."
check "get: hidden rejected" "s == 404" "$U/api.php?action=get&id=.hidden"
check "get: symlinked analysis rejected" "s == 404" "$U/api.php?action=get&id=linked"
check "get: missing id rejected" "s == 404" "$U/api.php?action=get"
check "get: unknown analysis 404" "s == 404" "$U/api.php?action=get&id=nope"
check "unknown action 400" "s == 400" "$U/api.php?action=nope"
check "uploaded .php is not executed" "s == 403 and 'EXECUTED' not in t" "$U/analyses/sneaky/evil.php"
check "uploaded .py served as text" "s == 200 and 'print' in t" "$U/analyses/sneaky/script.py"
check "uploaded .svg is not served" "s == 403 and '<script>' not in t" "$U/analyses/sneaky/plot.svg"
check "lib/ is private" "s == 403" "$U/lib/yaml.php"
check ".htaccess is private" "s == 403" "$U/analyses/.htaccess"
check "plot file served" "s == 200 and t.startswith('%PDF')" "$U/analyses/full-example/efficiency/eff_vs_eta.pdf"
check "contrib checker downloadable" "s == 200 and 'def parse_yaml' in t" "$U/contrib/check_analysis.py"
check "index page served" "s == 200 and 'assets/app.js' in t" "$U/"

if grep -qiE "fatal|warning|notice|deprecated" "$TMP/server.log"; then
  echo "FAIL PHP reported problems:"; grep -iE "fatal|warning|notice|deprecated" "$TMP/server.log" | head
  fails=$((fails + 1))
fi

echo
[ "$fails" -eq 0 ] && echo "ALL TESTS PASSED" || echo "$fails FAILURE(S)"
exit $((fails > 0))
