#!/usr/bin/env python3
"""Interactively create (or update) the analysis.yaml for an analysis folder.

    python3 make_analysis_yaml.py my-analysis/

Asks for the title, author, date, CMSSW version, tags, description, samples
and selection cuts, shows the result, and writes my-analysis/analysis.yaml.
Press Enter to accept the [default] shown or to skip a question. If the
folder already has an analysis.yaml, its values are offered as defaults, so
running this again is an easy way to edit it.

Plain Python 3, no packages needed. If check_analysis.py is in the same
folder, the result is also checked with it (recommended: download both).
"""

from __future__ import annotations

import datetime
import os
import re
import subprocess
import sys
import textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
try:
    from check_analysis import YamlError, check_meta, parse_yaml   # same YAML rules as the site
except ImportError:
    parse_yaml = check_meta = None

    class YamlError(Exception):
        pass

# The standard selection variables, in the order the site shows them.
CUT_VARS = [("eta", "|eta|"), ("z0", "|z0|"), ("d0", "|d0|"),
            ("pt", "pT"), ("lxy", "Lxy"), ("lz", "Lz")]
# The usual direction of each standard cut, suggested when a cut is typed
# without one (e.g. "2.4" -> "< 2.4").
USUAL_OP = {"eta": "<", "z0": "<", "d0": "<", "pt": ">", "lxy": "<", "lz": "<"}
# A cut "says which way" if it has a comparison or a range in it.
HAS_OP = re.compile(r"[<>≤≥=±]|\b(in|to|between|max|min|above|below)\b|\d\s*-\s*\d", re.I)
KNOWN = {"title", "author", "date", "cmssw", "tags", "description", "samples", "selection", "links"}


class Abort(Exception):
    pass


# =====================================================================
# Prompts
# =====================================================================

def ask(question, default="", required=False, check=None):
    """One line of input. Enter keeps the default; `check` returns an error
    message (or None) for a non-empty answer."""
    hint = f" [{default}]" if default else ""
    while True:
        try:
            ans = input(f"{question}{hint}: ").strip()
        except EOFError:
            raise Abort()
        if not ans:
            ans = default
        if not ans and required:
            print("  (required)")
            continue
        err = check(ans) if (ans and check) else None
        if err:
            print(f"  {err}")
            continue
        return ans


def yes(question, default=True):
    ans = ask(question + (" (Y/n)" if default else " (y/N)")).lower()
    return default if not ans else ans.startswith("y")


def ask_lines(question, default=""):
    """Several lines, ended by an empty line; a line with just "." starts a
    new paragraph. Enter on the first line keeps the default. Returns the
    text as paragraphs separated by "\n" (the way the site reads it back)."""
    print(f"{question} (finish with an empty line" + (", or Enter to keep the current text):" if default else "):"))
    if default:
        for line in default.rstrip("\n").split("\n"):
            print(f"  | {line}")
    lines = []
    while True:
        try:
            line = input("  > ").rstrip()
        except EOFError:
            raise Abort()
        if not line:
            if not lines:
                return default.strip()
            paras = "\n".join(lines).split("\n.\n")
            return "\n".join(" ".join(p.split()) for p in paras if p.strip())
        lines.append(line)


def ask_cut(label, default="", key=None, required=False):
    """A cut such as '< 2.4'. A bare value like '2.4' doesn't say which way
    the cut goes, so offer the usual direction for standard variables, or
    ask to confirm/retype for other cuts."""
    while True:
        cut = ask(label, default, required=required)
        if not cut or HAS_OP.search(cut):
            return cut
        op = USUAL_OP.get(key)
        if op:
            if yes(f"  '{cut}' doesn't say < or >. Use '{op} {cut}'?"):
                return f"{op} {cut}"
            if yes(f"  Keep '{cut}' as typed?", default=False):
                return cut
        elif yes(f"  '{cut}' doesn't say < or >, e.g. '>= {cut}'. Keep it as typed?", default=False):
            return cut
        default = ""


def check_date(s):
    try:
        datetime.date.fromisoformat(s)
    except ValueError:
        return "use YYYY-MM-DD, e.g. " + datetime.date.today().isoformat()
    return None


def check_key(s):
    if re.search(r":(\s|$)", s) or s[0] in "'\"[]{},&*!|>%@#`-" or s.lower() in KNOWN:
        return "use a plain name (no ': ', not starting with a symbol, not a standard field)"
    return None


def check_int(s):
    return None if re.fullmatch(r"\d+", s.replace(",", "")) else "a whole number, or Enter to skip"


# =====================================================================
# YAML output (the subset the site reads)
# =====================================================================

PLAIN = re.compile(r"^[A-Za-z0-9_./()+=<][^#\n]*$")


def scalar(v, in_list=False):
    """A YAML value: plain when unambiguous, otherwise double-quoted.
    Inside [a, b] lists, commas and brackets also need quotes."""
    s = str(v)
    if (s and PLAIN.match(s) and not re.search(r":(\s|$)", s) and s == s.strip()
            and s.lower() not in ("null", "~", "true", "false", "yes", "no")
            and not s.startswith("<<") and not (in_list and re.search(r"[,\[\]{}]", s))):
        return s
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def to_yaml(m):
    out = ["# Made with make_analysis_yaml.py; edit by hand or run it again."]
    for key in ("title", "author", "date", "cmssw"):
        if m.get(key):
            out.append(f"{key}: {scalar(m[key])}")
    if m.get("tags"):
        out.append("tags: [" + ", ".join(scalar(t, in_list=True) for t in m["tags"]) + "]")
    if m.get("description"):
        # Folded block: lines of a paragraph are joined with spaces when read,
        # and a blank line separates paragraphs.
        out.append("description: >")
        paras = [" ".join(p.split()) for p in m["description"].split("\n") if p.strip()]
        for i, para in enumerate(paras):
            if i:
                out.append("")
            out += ["  " + line for line in textwrap.wrap(para, 76, break_long_words=False,
                                                           break_on_hyphens=False)]
    if m.get("samples"):
        out.append("samples:")
        for s in m["samples"]:
            first = True
            for k in ("label", "path", "events"):
                if s.get(k):
                    out.append(("  - " if first else "    ") + f"{k}: {scalar(s[k])}")
                    first = False
    if m.get("selection"):
        out.append("selection:")
        for k, v in m["selection"].items():
            out.append(f"  {k}: {scalar(v)}")
    for k, v in m.get("details", {}).items():
        out.append(f"{k}: {scalar(v)}")
    return "\n".join(out) + "\n"


# =====================================================================
# Defaults
# =====================================================================

def default_author():
    try:
        name = subprocess.run(["git", "config", "user.name"], capture_output=True,
                              text=True, timeout=3).stdout.strip()
        if name:
            return name
    except Exception:
        pass
    try:
        import pwd
        return pwd.getpwuid(os.getuid()).pw_gecos.split(",")[0].strip()   # full name on lxplus
    except Exception:
        return ""


def load_existing(path):
    if not os.path.exists(path):
        return {}
    if parse_yaml is None:
        print(f"Note: {path} exists but check_analysis.py isn't next to this script, "
              "so its values can't be offered as defaults.")
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            meta = parse_yaml(f.read())
        print(f"Using the values in {path} as defaults.\n")
        return meta
    except (YamlError, UnicodeDecodeError) as e:
        print(f"Note: couldn't read the existing {path} ({e}); starting fresh.\n")
        return {}


def s(meta, key):
    v = meta.get(key)
    return v.strip() if isinstance(v, str) else ""


# =====================================================================
# Main
# =====================================================================

def interview(folder, old):
    m = {}
    name = os.path.basename(os.path.abspath(folder))

    print("== About the analysis ==")
    m["title"] = ask("Title", s(old, "title") or name)
    m["author"] = ask("Author (the site groups analyses by this)", s(old, "author") or default_author())
    m["date"] = ask("Date", s(old, "date") or datetime.date.today().isoformat(), check=check_date)
    m["cmssw"] = ask("CMSSW version", s(old, "cmssw") or os.environ.get("CMSSW_VERSION", ""))
    old_tags = old.get("tags") if isinstance(old.get("tags"), list) else []
    tags = ask("Tags, comma-separated (keywords for search)",
               ", ".join(t for t in old_tags if isinstance(t, str)))
    m["tags"] = [t.strip() for t in tags.split(",") if t.strip()]
    m["description"] = ask_lines("Description: a few sentences about the study. "
                                 "Type a single '.' line to start a new paragraph", s(old, "description"))

    print("\n== Samples ==")
    samples = []
    old_samples = [x for x in (old.get("samples") or []) if isinstance(x, (dict, str))]
    if old_samples and yes(f"Keep the {len(old_samples)} existing sample(s)?"):
        samples = [x if isinstance(x, dict) else {"label": x} for x in old_samples]
    while yes("Add a sample?" if not samples else "Add another sample?", default=not samples):
        label = ask("  Label (as in the plot legend)", required=True)
        path = ask("  Path or EOS URL of the input file")
        events = ask("  Number of events", check=check_int).replace(",", "")
        samples.append({"label": label, "path": path, "events": events})
    m["samples"] = samples

    print("\n== Selection cuts ==")
    print("Write each cut as it should read, including < or >, e.g. '< 2.4' or '> 2 GeV'. Enter = no cut.")
    old_sel = old.get("selection") if isinstance(old.get("selection"), dict) else {}
    sel = {}
    for key, label in CUT_VARS:
        cur = next((v for k, v in old_sel.items() if k.lower().replace("_", "") == key and isinstance(v, str)), "")
        cut = ask_cut(f"  {label}", cur, key)
        if cut:
            sel[key] = cut
    for k, v in old_sel.items():
        if k.lower().replace("_", "") not in dict(CUT_VARS) and isinstance(v, str) \
                and yes(f"  Keep the extra cut '{k}: {v}'?"):
            sel[k] = v
    while yes("Add another cut (e.g. nstub, chi2/dof)?", default=False):
        k = ask("  Name", required=True, check=check_key)
        sel[k] = ask_cut("  Cut", required=True)
    m["selection"] = sel

    print("\n== Details (optional) ==")
    print("Any other information, shown in a Details table (e.g. 'resolution method').")
    details = {k: v for k, v in old.items() if k not in KNOWN and isinstance(v, str)}
    if details and not yes(f"Keep the {len(details)} existing detail(s)?"):
        details = {}
    while yes("Add a detail?", default=False):
        k = ask("  Name", required=True, check=check_key)
        details[k] = ask("  Value", required=True)
    m["details"] = details

    dropped = [k for k, v in old.items()
               if (k == "links" or (k not in KNOWN and not isinstance(v, str))) and v]
    if dropped:
        print(f"\nNote: {', '.join(dropped)} from the old file can't be edited here and will "
              "be left out; add them back by hand if you need them.")
    return m


def main(argv):
    if len(argv) > 2 or (len(argv) == 2 and argv[1] in ("-h", "--help")):
        print(__doc__.strip())
        return 0
    folder = argv[1] if len(argv) == 2 else "."
    if not os.path.isdir(folder):
        print(f"error: {folder} is not a folder")
        return 2
    path = os.path.join(folder, "analysis.yaml")
    print(f"Creating {path}. Press Enter to accept [defaults]; Ctrl-C to quit.\n")
    old = load_existing(path)

    try:
        m = interview(folder, old)
    except (Abort, KeyboardInterrupt):
        print("\nCancelled; nothing written.")
        return 1

    text = to_yaml(m)
    if parse_yaml is not None:      # make sure the site will read it back exactly
        try:
            back = parse_yaml(text)
        except YamlError as e:
            print(f"internal error: generated YAML doesn't parse ({e}); please report this")
            return 3
        problems = [msg for kind, msg in check_meta(back) if kind == "error"]
        for msg in problems:
            print(f"warning: {msg}")

    print("\n" + "-" * 60 + "\n" + text + "-" * 60)
    try:
        if os.path.exists(path) and not yes(f"Overwrite {path}?", default=False):
            print("Nothing written.")
            return 1
        if not os.path.exists(path) and not yes(f"Write {path}?"):
            print("Nothing written.")
            return 1
    except (Abort, KeyboardInterrupt):
        print("\nCancelled; nothing written.")
        return 1
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"Wrote {path}.")
    if parse_yaml is not None:
        print(f"Next: python3 {os.path.join(HERE, 'check_analysis.py')} {folder}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
