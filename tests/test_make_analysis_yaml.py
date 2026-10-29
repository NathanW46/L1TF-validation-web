#!/usr/bin/env python3
"""Drive contrib/make_analysis_yaml.py with piped answers and check that the
file it writes reads back (with the site's YAML rules) exactly as typed.

    python3 tests/test_make_analysis_yaml.py
"""

import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRIB = os.path.join(HERE, "..", "public", "contrib")
SCRIPT = os.path.join(CONTRIB, "make_analysis_yaml.py")
sys.path.insert(0, CONTRIB)
from check_analysis import parse_yaml  # noqa: E402

fails = 0


def run(folder, answers, env_extra=None):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", **(env_extra or {}))
    return subprocess.run([sys.executable, SCRIPT, folder], input="\n".join(answers) + "\n",
                          capture_output=True, text=True, env=env, timeout=30)


def expect(desc, got, want):
    global fails
    if got == want:
        print(f"ok   {desc}")
    else:
        fails += 1
        print(f"FAIL {desc}\n  want {want!r}\n  got  {got!r}")


with tempfile.TemporaryDirectory() as tmp:
    folder = os.path.join(tmp, "my-study")
    os.mkdir(folder)
    yaml_path = os.path.join(folder, "analysis.yaml")

    # ---- 1. fresh file, awkward values everywhere --------------------------
    answers = [
        'Run #3: "tricky" study',            # title  (# and : and quotes)
        "Test Person",                        # author
        "",                                   # date -> today (default)
        "",                                   # cmssw -> $CMSSW_VERSION (default)
        "displaced, a,b-ish?, PR391",         # tags (comma split; ',' inside is split)
        "First line of text,",                # description ...
        "  continued with leading spaces.",
        ".",                                  # paragraph break
        "Second paragraph: with colon # and hash.",
        "",                                   # end description
        "",                                   # add an input? (default yes)
        "SIM Disp.", "HYBRID_DISPLACED", "SUSY 200PU", "/RelValX/Y-v1/GEN-SIM", "1,000",
        "y",                                  # another input
        "> weird label", "", "TTbar: #2", "", "",
        "n",                                  # no more inputs
        "< 2.4", "", "< 1 cm", "> 2 GeV", "", "",   # eta z0 d0 pt lxy lz
        "y", "nstub", ">= 4",                 # extra cut
        "y", "bad: key", "chi2/dof", "< 10",  # invalid name re-prompted
        "n",
        "y", "resolution method", "68% interval",
        "n",
        "",                                   # write? (default yes)
    ]
    r = run(folder, answers, {"CMSSW_VERSION": "CMSSW_15_1_0_pre3"})
    expect("fresh run exits 0", r.returncode, 0)
    expect("invalid detail name re-prompted", "use a plain name" in r.stdout, True)
    with open(yaml_path) as f:
        text = f.read()
    meta = parse_yaml(text)
    import datetime
    expect("title", meta.get("title"), 'Run #3: "tricky" study')
    expect("author", meta.get("author"), "Test Person")
    expect("date defaults to today", meta.get("date"), datetime.date.today().isoformat())
    expect("cmssw from $CMSSW_VERSION", meta.get("cmssw"), "CMSSW_15_1_0_pre3")
    expect("tags", meta.get("tags"), ["displaced", "a", "b-ish?", "PR391"])
    expect("description paragraphs",
           meta.get("description"),
           "First line of text, continued with leading spaces.\nSecond paragraph: with colon # and hash.\n")
    long_para = text.split("description: >\n", 1)[1]
    expect("description written as indented lines", long_para.startswith("  First line of text, continued"), True)
    expect("inputs", meta.get("inputs"), [
        {"label": "SIM Disp.", "algo": "HYBRID_DISPLACED", "mc_sample": "SUSY 200PU",
         "mc_path": "/RelValX/Y-v1/GEN-SIM", "events": "1000"},
        {"label": "> weird label", "mc_sample": "TTbar: #2"},
    ])
    expect("selection", meta.get("selection"),
           {"eta": "< 2.4", "d0": "< 1 cm", "pt": "> 2 GeV", "nstub": ">= 4", "chi2/dof": "< 10"})
    expect("details", meta.get("resolution method"), "68% interval")

    # ---- 2. re-run, Enter everywhere: nothing changes ------------------------
    rerun = [""] * 6 + [""]                # title..tags + description (keep), keep inputs (Y)
    rerun += ["n"]                          # no extra input
    rerun += [""] * 6                       # standard cuts keep
    rerun += ["", ""]                       # keep extra cuts nstub, chi2/dof
    rerun += ["n"]                          # no more cuts
    rerun += ["", "n"]                      # keep details, no more
    rerun += ["y"]                          # overwrite
    r = run(folder, rerun)
    expect("re-run exits 0", r.returncode, 0)
    expect("re-run used existing values", "Using the values in" in r.stdout, True)
    with open(yaml_path) as f:
        expect("re-run with Enter keeps the file identical", f.read(), text)

    # ---- 2b. a long description is wrapped and still reads back exactly -------
    words = " ".join(f"word{i}" for i in range(60))
    r = run(folder, [""] * 5 + [words, ".", "Short.", ""] + [""] + ["n"] + [""] * 6 + ["", "", "n", "", "n", "y"])
    with open(yaml_path) as f:
        t2 = f.read()
    expect("long description wrapped to <= 78 columns", max(len(l) for l in t2.splitlines()) <= 78, True)
    expect("long description reads back exactly", parse_yaml(t2).get("description"), words + "\nShort.\n")

    # ---- 2c. cuts typed without < or > ----------------------------------------
    folder2 = os.path.join(tmp, "bare-cuts")
    os.mkdir(folder2)
    r = run(folder2, ["", "", "", "", "", "",   # title..tags, description
                      "n",                      # no inputs
                      "2.4", "",                # |eta| 2.4 -> accept suggested "< 2.4"
                      "15", "n", "y",           # |z0| 15 -> decline "< 15", keep as typed
                      "",                       # |d0| no cut
                      "2", "",                  # pT 2 -> accept "> 2"
                      "", "",                   # Lxy, Lz no cut
                      "y", "nstub", "4", "n", ">= 4",   # extra cut: bare 4 -> retype
                      "n",                      # no more cuts
                      "n",                      # no details
                      ""])                      # write
    expect("bare cuts: run exits 0", r.returncode, 0)
    expect("bare cuts: suggestion shown", "doesn't say < or >. Use '< 2.4'?" in r.stdout, True)
    with open(os.path.join(folder2, "analysis.yaml")) as f:
        expect("bare cuts: directions added / kept / retyped", parse_yaml(f.read()).get("selection"),
               {"eta": "< 2.4", "z0": "15", "pt": "> 2", "nstub": ">= 4"})

    # ---- 3. Ctrl-D part-way: nothing written ---------------------------------
    os.remove(yaml_path)
    r = run(folder, ["Only a title"])
    expect("EOF cancels", (r.returncode, os.path.exists(yaml_path)), (1, False))

    # ---- 4. declining to write ------------------------------------------------
    r = run(folder, [""] * 6 + ["n"] + [""] * 6 + ["n", "n", "n"])
    expect("answering n to Write leaves no file", (r.returncode, os.path.exists(yaml_path)), (1, False))

print("\nALL OK" if not fails else f"\n{fails} FAILURE(S)")
sys.exit(1 if fails else 0)
