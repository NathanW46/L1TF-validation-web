#!/usr/bin/env python3
"""Check an analysis folder before copying it to the plots website.

    python3 check_analysis.py path/to/my-analysis/

Reports what the website will show (title, author, plots per folder) and
any problems. Exits with status 1 if there are errors, i.e. things the site
can't display. Warnings are suggestions only.

The YAML reader below is the same small YAML subset the website (lib/yaml.php)
understands; tests/run_tests.sh keeps the two in sync. It needs no third-party packages,
so this file can be copied anywhere and run on its own.
"""

from __future__ import annotations

import datetime
import os
import re
import sys

# =====================================================================
# YAML subset
# =====================================================================
#
# Supported: "key: value" maps, nested by indentation (spaces only);
# "- item" lists, including lists of maps; # comments; "double" and
# 'single' quoted strings; inline lists [a, b]; block text with > (folded)
# or | (literal), optionally >- / |-. Plain values stay strings; ~ and null
# become null. Anything else is an error naming the line.


class YamlError(Exception):
    pass


KEY_BAD_START = "'\"[]{},&*!|>%@#`"
ESCAPES = {'"': '"', "\\": "\\", "/": "/", "n": "\n", "t": "\t"}


class _Parser:
    def __init__(self, text):
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        if text.startswith("﻿"):
            text = text[1:]
        self.lines = text.split("\n")
        self.n = len(self.lines)
        self.i = 0

    def err(self, i, msg):
        raise YamlError(f"line {i + 1}: {msg}")

    def indent(self, i):
        line = self.lines[i]
        k = 0
        while k < len(line) and line[k] == " ":
            k += 1
        if k < len(line) and line[k] == "\t":
            self.err(i, "tabs are not allowed for indentation")
        return k

    def skip(self, i):
        """Index of the next line that isn't blank or a comment."""
        while i < self.n:
            s = self.lines[i].strip()
            if s != "" and not s.startswith("#"):
                return i
            i += 1
        return i

    def parse(self):
        i = self.skip(0)
        if i < self.n and self.lines[i].strip() == "---":
            i = self.skip(i + 1)
        if i >= self.n:
            return {}
        if self.indent(i) != 0:
            self.err(i, "unexpected indentation")
        content = self.lines[i].strip()
        if content == "-" or content.startswith("- "):
            self.err(i, "the top level must be 'key: value' lines")
        self.i = i
        result = self.parse_map(0, {})
        i = self.skip(self.i)
        if i < self.n:
            self.err(i, "unexpected indentation")
        return result

    def block(self, ind):
        content = self.lines[self.i][ind:]
        if content == "-" or content.startswith("- "):
            return self.parse_list(ind)
        return self.parse_map(ind, {})

    @staticmethod
    def find_key(content):
        """(key, rest) if content looks like 'key: value', else None. The key
        ends at the first ':' followed by a space, tab or end of line."""
        for k, c in enumerate(content):
            if c == ":" and (k + 1 == len(content) or content[k + 1] in " \t"):
                key = content[:k].strip()
                if key == "" or key[0] in KEY_BAD_START or key.startswith("- "):
                    return None
                return key, content[k + 1:]
        return None

    def split_key(self, i, content):
        kv = self.find_key(content)
        if kv is None:
            self.err(i, "expected 'key: value'")
        return kv

    def parse_map(self, ind, result):
        while True:
            i = self.skip(self.i)
            if i >= self.n:
                break
            li = self.indent(i)
            if li < ind:
                break
            if li > ind:
                self.err(i, "unexpected indentation")
            content = self.lines[i][li:]
            if content == "-" or content.startswith("- "):
                break   # a list at the parent key's indentation ends here
            key, rest = self.split_key(i, content)
            if key in result:
                self.err(i, f"duplicate key '{key}'")
            self.i = i + 1
            result[key] = self.value(rest, ind, i)
        return result

    def parse_list(self, ind):
        result = []
        while True:
            i = self.skip(self.i)
            if i >= self.n:
                break
            li = self.indent(i)
            if li < ind:
                break
            if li > ind:
                self.err(i, "unexpected indentation")
            content = self.lines[i][li:]
            if not (content == "-" or content.startswith("- ")):
                break
            self.i = i + 1
            after = content[1:]
            item = after.lstrip(" ")
            col = li + 1 + (len(after) - len(item))
            if item == "-" or item.startswith("- "):
                self.err(i, "nested '- -' list items are not supported")
            if self.find_key(item) is not None:
                key, rest = self.split_key(i, item)
                m = {key: self.value(rest, col, i)}
                result.append(self.parse_map(col, m))
            else:
                result.append(self.value(item, ind, i))
        return result

    def value(self, rest, ind, i):
        """The value after 'key:' or '- ' on line i (ind = that line's
        indentation)."""
        kind, val = self.scalar(rest, i)
        if kind == "empty":
            j = self.skip(self.i)
            if j < self.n:
                lj = self.indent(j)
                cj = self.lines[j][lj:]
                if lj > ind or (lj == ind and (cj == "-" or cj.startswith("- "))):
                    self.i = j
                    return self.block(lj)
            return None
        if kind == "block":
            return self.block_text(val, ind)
        return val

    def scalar(self, s, i):
        """('empty'|'block'|'value', value) for the text of one value."""
        s = s.strip()
        if s == "":
            return "empty", None
        c = s[0]
        if c == '"' or c == "'":
            val, end = self.quoted(s, 0, i)
            self.check_tail(s[end:], i, "unexpected text after quoted string")
            return "value", val
        if c == "[":
            return "value", self.inline_list(s, i)
        if c == "{":
            self.err(i, "inline maps {...} are not supported")
        if c in "&*!%@`":
            self.err(i, f"'{c}' at the start of a value is not supported (put the value in quotes)")
        # plain: a comment starts at '#' preceded by whitespace
        cut = re.search(r"(^|[ \t])#", s)
        if cut:
            s = s[:cut.start()].rstrip()
        if s == "":
            return "empty", None
        if s in (">", "|", ">-", "|-"):
            return "block", s
        if s in ("~", "null"):
            return "value", None
        return "value", s

    def check_tail(self, tail, i, msg):
        tail = tail.strip()
        if tail and not tail.startswith("#"):
            self.err(i, msg)

    def quoted(self, s, k, i):
        """Parse the quoted string starting at s[k]; returns (value, index
        after the closing quote)."""
        q = s[k]
        out = []
        k += 1
        while k < len(s):
            c = s[k]
            if q == "'" and c == "'":
                if k + 1 < len(s) and s[k + 1] == "'":
                    out.append("'")
                    k += 2
                    continue
                return "".join(out), k + 1
            if q == '"' and c == "\\":
                if k + 1 >= len(s):
                    break
                e = s[k + 1]
                if e not in ESCAPES:
                    self.err(i, f"unsupported escape '\\{e}'")
                out.append(ESCAPES[e])
                k += 2
                continue
            if q == '"' and c == '"':
                return "".join(out), k + 1
            out.append(c)
            k += 1
        self.err(i, "unterminated quoted string")

    def inline_list(self, s, i):
        items = []
        k = 1
        while True:
            while k < len(s) and s[k] in " \t":
                k += 1
            if k >= len(s):
                self.err(i, "unterminated list '['")
            c = s[k]
            if c == "]" and not items:
                k += 1
                break
            if c == '"' or c == "'":
                val, k = self.quoted(s, k, i)
            elif c == "[":
                self.err(i, "nested lists [...] are not supported")
            elif c == "{":
                self.err(i, "inline maps {...} are not supported")
            else:
                start = k
                while k < len(s) and s[k] not in ",]":
                    k += 1
                val = s[start:k].strip()
                if val in ("~", "null"):
                    val = None
            items.append(val)
            while k < len(s) and s[k] in " \t":
                k += 1
            if k >= len(s):
                self.err(i, "unterminated list '['")
            if s[k] == ",":
                k += 1
                continue
            if s[k] == "]":
                k += 1
                break
            self.err(i, "expected ',' or ']' in list")
        self.check_tail(s[k:], i, "unexpected text after list")
        return items

    def block_text(self, style, ind):
        out = []
        i = self.i
        block_ind = None
        while i < self.n:
            raw = self.lines[i]
            if raw.strip() == "":
                out.append("")
                i += 1
                continue
            li = len(raw) - len(raw.lstrip(" "))
            if li <= ind:
                break
            if block_ind is None:
                block_ind = li
            elif li < block_ind:
                self.err(i, "block text is less indented than its first line")
            out.append(raw[block_ind:])
            i += 1
        self.i = i
        while out and out[-1] == "":
            out.pop()
        if style[0] == "|":
            text = "\n".join(out)
        else:
            text = ""
            for line in out:
                if line == "":
                    text += "\n"
                else:
                    if text and not text.endswith("\n"):
                        text += " "
                    text += line
        if text and not style.endswith("-"):
            text += "\n"
        return text


def parse_yaml(text):
    """Parse the YAML subset. Raises YamlError("line N: ...")."""
    return _Parser(text).parse()


# =====================================================================
# Folder rules (mirror lib/scan.php)
# =====================================================================

ID_RE = re.compile(r"^[A-Za-z0-9._-]+$")
PLOT_EXTS = ["pdf", "png", "jpg", "jpeg", "gif", "webp"]
# Not shown at all (an SVG opened directly could run scripts on the site).
SKIP_EXTS = ["svg", "svgz"]
META_FILES = ["analysis.yaml", "analysis.yml"]
NOTES_FILES = ["notes.md", "notes.txt"]
MAX_DEPTH = 8
MAX_FILES = 5000


def scan(root):
    """(plots, files, newest_mtime, problems). plots maps the stem path
    (relative, no extension) -> {ext: relpath}."""
    plots, files, problems = {}, [], []
    skipped = []
    newest = 0.0
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        rel_dir = "" if rel_dir == "." else rel_dir
        depth = 0 if not rel_dir else rel_dir.count(os.sep) + 1
        keep = []
        for d in sorted(dirnames):
            full = os.path.join(dirpath, d)
            if d.startswith("."):
                continue
            if os.path.islink(full):
                problems.append(("warn", f"{os.path.join(rel_dir, d)}/ is a symlink; it will be ignored"))
                continue
            if depth + 1 > MAX_DEPTH:
                problems.append(("warn", f"{os.path.join(rel_dir, d)}/ is nested deeper than {MAX_DEPTH} folders; it will be ignored"))
                continue
            keep.append(d)
        dirnames[:] = keep
        for f in sorted(filenames):
            full = os.path.join(dirpath, f)
            rel = os.path.join(rel_dir, f) if rel_dir else f
            if f.startswith(".") or os.path.islink(full):
                continue
            if os.path.splitext(f)[1][1:].lower() in SKIP_EXTS:
                skipped.append(rel)
                continue
            count += 1
            if count > MAX_FILES:
                problems.append(("warn", f"more than {MAX_FILES} files; the rest will be ignored"))
                return plots, files, newest, problems
            newest = max(newest, os.path.getmtime(full))
            if not rel_dir and f.lower() in META_FILES + NOTES_FILES:
                continue
            stem, ext = os.path.splitext(rel)
            ext = ext[1:].lower()
            if ext in PLOT_EXTS:
                plots.setdefault(stem.replace(os.sep, "/"), {})[ext] = rel
            else:
                files.append(rel)
    if skipped:
        problems.append(("warn", f"{len(skipped)} SVG file(s) will be ignored (e.g. '{skipped[0]}'); "
                         "SVG isn't supported, save the plot as PDF or PNG instead"))
    return plots, files, newest, problems


def _is_str(v):
    return isinstance(v, str) and v.strip() != ""


def check_meta(meta):
    """Problems with the analysis.yaml contents."""
    out = []
    for key in ("title", "author", "date", "cmssw", "description"):
        if key in meta and meta[key] is not None and not isinstance(meta[key], str):
            out.append(("error", f"'{key}' should be a single value, not a list or map"))
    if _is_str(meta.get("date")):
        try:
            datetime.date.fromisoformat(meta["date"].strip())
        except ValueError:
            out.append(("warn", f"date '{meta['date']}' isn't YYYY-MM-DD, so sorting by date may be off"))
    tags = meta.get("tags")
    if tags is not None and not isinstance(tags, (str, list)):
        out.append(("error", "'tags' should be a list like [a, b]"))
    for key, required in (("samples", "label"), ("links", "url")):
        v = meta.get(key)
        if v is None:
            continue
        if not isinstance(v, list):
            out.append(("error", f"'{key}' should be a list of '- {required}: ...' entries"))
            continue
        for n, item in enumerate(v, 1):
            if not isinstance(item, dict):
                if key == "samples" and isinstance(item, str):
                    continue   # a bare sample name is fine
                out.append(("error", f"{key} entry {n} should be '{required}: ...' lines"))
            elif not _is_str(item.get(required)):
                out.append(("error", f"{key} entry {n} has no '{required}'"))
            elif key == "links" and not re.match(r"^https?://", item["url"].strip()):
                out.append(("error", f"links entry {n}: url must start with http:// or https://"))
    sel = meta.get("selection")
    if isinstance(sel, dict):
        for k, v in sel.items():
            if v is not None and not isinstance(v, str):
                out.append(("error", f"selection '{k}' should be a single cut like \"< 2.5\""))
            elif isinstance(v, str) and v.strip() and not CUT_OP.search(v):
                op = USUAL_OP.get(re.sub(r"[^a-z0-9]", "", k.lower()))
                hint = f'"{op} {v.strip()}"' if op else f'"< {v.strip()}" or "> {v.strip()}"'
                out.append(("warn", f"selection '{k}: {v}' doesn't say which way the cut goes; "
                            f"write e.g. {hint} (quote it, since it starts with < or >)"))
    elif sel is not None and not isinstance(sel, str):
        out.append(("error", "'selection' should be 'variable: cut' lines, e.g.  eta: \"< 2.5\""))
    for key in ("title", "author"):
        if not _is_str(meta.get(key)):
            out.append(("warn", f"no '{key}' set; the site will use "
                        + ("the folder name" if key == "title" else "'Unknown'")))
    return out


# A cut "says which way" if it has a comparison or a range in it.
# The usual direction of the standard cuts, for suggestions.
USUAL_OP = {"eta": "<", "z0": "<", "d0": "<", "dxy": "<", "dz": "<", "lxy": "<", "lz": "<",
            "pt": ">"}
CUT_OP = re.compile(r"[<>≤≥=±]|\b(in|to|between|max|min|above|below)\b|\d\s*-\s*\d", re.I)

GENERIC = re.compile(r"^(plot|fig|figure|canvas|c|img|image|untitled)?[_-]?\d*$", re.I)


def main(argv):
    if len(argv) != 2 or argv[1] in ("-h", "--help"):
        print(__doc__.strip())
        return 2
    root = argv[1].rstrip("/") or "/"
    if not os.path.isdir(root):
        print(f"error: {root} is not a folder")
        return 2

    problems = []
    name = os.path.basename(os.path.abspath(root))
    if not ID_RE.match(name):
        problems.append(("error", f"folder name '{name}' may only contain letters, digits, '.', '_' "
                         "and '-' (it becomes the analysis id in links)"))

    meta = {}
    meta_file = next((f for f in os.listdir(root) if f.lower() in META_FILES), None)
    if meta_file:
        try:
            with open(os.path.join(root, meta_file), encoding="utf-8") as f:
                meta = parse_yaml(f.read())
            problems += check_meta(meta)
        except YamlError as e:
            problems.append(("error", f"{meta_file}, {e}"))
        except UnicodeDecodeError:
            problems.append(("error", f"{meta_file} is not UTF-8 text"))
    else:
        problems.append(("warn", "no analysis.yaml; the site will show the folder name, author "
                         "'Unknown' and the newest file date (template: contrib/analysis.yaml on the site)"))

    plots, files, newest, scan_problems = scan(root)
    problems += scan_problems
    if not plots:
        problems.append(("error", "no plots found (supported: " + ", ".join(PLOT_EXTS) + ")"))
    generic = [s for s in plots if GENERIC.match(s.rsplit("/", 1)[-1])]
    if generic:
        problems.append(("warn", f"{len(generic)} plot name(s) say nothing about the plot "
                         f"(e.g. '{generic[0]}'); search works on filenames, so names like "
                         "'d0_vs_eta_mind0-0p2' are easier to find"))

    notes = next((f for f in os.listdir(root) if f.lower() in NOTES_FILES), None)

    title = meta.get("title") if _is_str(meta.get("title")) else name
    author = meta.get("author") if _is_str(meta.get("author")) else "Unknown"
    date = (meta.get("date") if _is_str(meta.get("date"))
            else datetime.date.fromtimestamp(newest).isoformat() if newest else "?")
    print(f"Analysis : {name}")
    print(f"Title    : {title}")
    print(f"Author   : {author}")
    print(f"Date     : {date}")
    print(f"Notes    : {notes or '-'}")
    by_dir = {}
    for stem, fmts in plots.items():
        by_dir.setdefault(stem.rsplit("/", 1)[0] if "/" in stem else "(top level)", []).append(fmts)
    print(f"Plots    : {len(plots)}")
    for d in sorted(by_dir):
        fmts = by_dir[d]
        n_pdf = sum("pdf" in f for f in fmts)
        print(f"  {d}: {len(fmts)} plot(s), {n_pdf} with PDF")
    if files:
        print(f"Files    : {len(files)} other file(s), listed for download")

    errors = [m for kind, m in problems if kind == "error"]
    warns = [m for kind, m in problems if kind == "warn"]
    for m in warns:
        print(f"warning: {m}")
    for m in errors:
        print(f"ERROR: {m}")
    print("\nOK, ready to upload." if not errors else f"\n{len(errors)} error(s); fix before uploading.")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
