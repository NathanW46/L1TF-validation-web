// Tracking plot browser. Talks to api.php, which scans analyses/ on the
// server; nothing here needs a build step.
//
// URL hash (shareable):  #a=<analysis id>&q=<plot search>&fmt=png&plot=<path>
//                        #help  — how to add an analysis
"use strict";

// ---------------------------------------------------------------- config

// Where contributors copy their analysis folders (shown in the help page).
const UPLOAD_DIR = "/eos/user/n/nwhittin/www/public/analyses";
// Who to contact about the site, and where its code lives (menu footer + help page).
const CONTACT = { name: "Nathan Whittington", email: "nathan.whittington@cern.ch" };
const REPO = "https://github.com/NathanW46/L1TF-validation-web";

const API = "api.php";
const LIBS = {
  pdfjs: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  pdfWorker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  marked: "https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js",
  purify: "https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js",
};
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];
// analysis.yaml keys with their own place on the page; the rest go in Details.
// ("links" is accepted but no longer shown.)
const KNOWN_KEYS = new Set(["title", "author", "date", "cmssw", "tags", "description", "inputs", "selection", "links"]);
const PDF_CONCURRENCY = 3;

// ---------------------------------------------------------------- helpers

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const isHttp = (u) => typeof u === "string" && /^https?:\/\//i.test(u.trim());
const narrow = () => window.matchMedia("(max-width: 860px)").matches;

const store = {
  get(key, dflt) {
    try {
      const v = localStorage.getItem("plots." + key);
      return v === null ? dflt : JSON.parse(v);
    } catch (e) {
      return dflt;
    }
  },
  set(key, v) {
    try { localStorage.setItem("plots." + key, JSON.stringify(v)); } catch (e) { /* private mode */ }
  },
};

const scripts = new Map();
function loadScript(src) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { scripts.delete(src); reject(new Error("could not load " + src)); };
      document.head.appendChild(s);
    }));
  }
  return scripts.get(src);
}

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  let data = null;
  try { data = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok || !data) {
    const err = new Error((data && data.error) || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} kB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// ---------------------------------------------------------------- search
//
// Everything is matched against words: a path like
// "resolution/mind0-0p2/d0_res_vs_eta" -> resolution, mind0, 0p2, d0, res, vs, eta.
// Each typed word must match the start of some word, or be another name for
// the same variable (see ALIASES); "A vs B" also needs A to come before B.

// Standard names: every alias maps to one canonical word. Greek letters,
// subscripts and ROOT/LaTeX spellings are normalised first (normText).
const ALIASES = {
  eta: "eta", pseudorapidity: "eta",
  phi: "phi",
  pt: "pt", ptrans: "pt",
  d0: "d0", dxy: "d0",
  z0: "z0", dz: "z0",
  lxy: "lxy", rxy: "lxy",
  lz: "lz",
  eff: "eff", efficiency: "eff", efficiencies: "eff",
  res: "res", reso: "res", resolution: "res", resolutions: "res",
};
const canon = (w) => ALIASES[w] || w;
// How canonical words are shown on the filter chips and in tables.
const SYMBOLS = {
  eta: "η", phi: "φ", pt: "p<sub>T</sub>", d0: "d<sub>0</sub>", z0: "z<sub>0</sub>",
  lxy: "L<sub>xy</sub>", lz: "L<sub>z</sub>", eff: "efficiency", res: "resolution",
};
const symbol = (w) => SYMBOLS[w] || esc(w);

function normText(s) {
  return String(s).toLowerCase()
    .replace(/[₀-₉]/g, (c) => String(c.charCodeAt(0) - 0x2080))
    .replace(/η/g, " eta ").replace(/φ/g, " phi ")
    .replace(/transverse\s+momentum/g, " pt ")
    .replace(/(transverse\s+)?impact\s+parameter/g, " d0 ")
    .replace(/pseudo-rapidity/g, " eta ")
    .replace(/\bp_?\{?t\}?(?![a-z0-9])/g, "pt")          // p_T, p_{T}
    .replace(/\b([dz])_\{?0\}?(?![a-z0-9])/g, "$10")      // d_0, z_{0}
    .replace(/\bl_\{?(xy|z)\}?(?![a-z0-9])/g, "l$1");     // L_xy, L_{z}
}

const splitWords = (s) => normText(s).split(/[\s/_\-.,:;()[\]{}#|$\\^]+/).filter(Boolean);

// Does word w satisfy typed token t?
const hit = (w, t) => w.startsWith(t) || canon(w) === canon(t);

function parseQuery(q) {
  const pairs = [];
  const tokens = [];
  const rest = normText(q).replace(/(\S+)\s+vs\.?\s+(\S+)/g, (_, a, b) => {
    const wa = splitWords(a), wb = splitWords(b);
    if (wa.length && wb.length) {
      pairs.push([wa[wa.length - 1], wb[0]]);
      tokens.push(...wa.slice(0, -1), ...wb.slice(1));
    }
    return " ";
  });
  tokens.push(...splitWords(rest));
  return { pairs, tokens, empty: !pairs.length && !tokens.length };
}

function matchWords(words, parsed) {
  if (parsed.empty) return true;
  for (const t of parsed.tokens) {
    if (!words.some((w) => hit(w, t))) return false;
  }
  for (const [a, b] of parsed.pairs) {
    if (!pairMatch(words, a, b)) return false;
  }
  return true;
}

// "A vs B": if the name itself has a "vs", A must come before it and B
// after it (so "res vs eta" doesn't match resolution/eta_res_vs_d0);
// otherwise A just has to come before B.
function pairMatch(words, a, b) {
  const vs = words.map((w, k) => (w === "vs" ? k : -1)).filter((k) => k >= 0);
  for (let i = 0; i < words.length; i++) {
    if (!hit(words[i], a)) continue;
    for (let j = i + 1; j < words.length; j++) {
      if (!hit(words[j], b)) continue;
      if (!vs.length || vs.some((k) => i < k && k < j)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- state

const state = {
  analyses: [],
  navQ: "",
  group: store.get("group", "author"),
  sort: store.get("sort", "date"),
  closedAuthors: new Set(store.get("closedAuthors", [])),
  current: null,          // full analysis from api.php?action=get
  q: "",
  fmt: "pdf",
  shown: [],              // plots after the plot search
  closedDirs: new Set(),
  open: -1,               // index into shown, or -1
};

// ---------------------------------------------------------------- URL hash

function readHash() {
  const raw = location.hash.slice(1);
  if (raw === "help" || raw === "contact") return { help: true };
  const h = new URLSearchParams(raw);
  return { a: h.get("a"), q: h.get("q") || "", fmt: h.get("fmt"), plot: h.get("plot") };
}

function writeHash(push) {
  let str = "";
  if (state.current) {
    const h = new URLSearchParams();
    h.set("a", state.current.id);
    if (state.q) h.set("q", state.q);
    if (state.fmt !== "pdf") h.set("fmt", state.fmt);
    if (state.open >= 0) h.set("plot", state.shown[state.open].path);
    str = "#" + h.toString().replace(/%2F/gi, "/");
  }
  routedHash = str;
  if (str === location.hash) return;
  const url = str || location.pathname + location.search;
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}

// ---------------------------------------------------------------- left menu

function prepAnalyses(list) {
  for (const a of list) {
    a._words = splitWords([a.title, a.author, a.id || "", a.date, ...(a.tags || [])].join(" "));
    a._plotWords = (a.plots || []).map(splitWords);
  }
  return list;
}

function navMatches() {
  const parsed = parseQuery(state.navQ);
  const out = [];
  for (const a of state.analyses) {
    const meta = matchWords(a._words, parsed);
    const hits = parsed.empty ? 0 : a._plotWords.filter((w) => matchWords(w, parsed)).length;
    if (meta || hits) out.push({ a, meta, hits });
  }
  const byName = (x, y) => collator.compare(x.a.title, y.a.title);
  out.sort(state.sort === "name" ? byName
    : (x, y) => (y.a.date || "").localeCompare(x.a.date || "") || byName(x, y));
  return out;
}

function navItem({ a, meta, hits }) {
  const cur = state.current && a.id === state.current.id;
  const bits = [];
  if (a.date) bits.push(esc(a.date));
  bits.push(`${a.n_plots} plot${a.n_plots === 1 ? "" : "s"}`);
  if (state.group !== "author") bits.push(esc(a.author));
  let badges = "";
  if (hits && !meta) badges += ` <span class="badge hit">${hits} match${hits === 1 ? "" : "es"}</span>`;
  else if (hits) badges += ` <span class="badge hit">${hits} plot${hits === 1 ? "" : "s"}</span>`;
  if (a.error) badges += ` <span class="badge warn" title="${esc(a.error)}">problem</span>`;
  return `<li><button class="nav-item" ${a.id ? `data-id="${esc(a.id)}"` : "disabled"}
      data-plotq="${hits && !meta ? "1" : ""}" aria-current="${cur}" title="${esc(a.error || a.title)}">
    <span class="t">${esc(a.title)}</span>
    <span class="s">${bits.join(" · ")}${badges}</span>
  </button></li>`;
}

function renderNav() {
  for (const b of document.querySelectorAll("[data-group]")) b.setAttribute("aria-pressed", b.dataset.group === state.group);
  for (const b of document.querySelectorAll("[data-sort]")) b.setAttribute("aria-pressed", b.dataset.sort === state.sort);

  const items = navMatches();
  const list = $("nav-list");
  if (!state.analyses.length) {
    list.innerHTML = `<p class="nav-empty">No analyses yet.</p>`;
    return;
  }
  if (!items.length) {
    list.innerHTML = `<p class="nav-empty">Nothing matches “${esc(state.navQ)}”.</p>`;
    return;
  }
  if (state.group !== "author") {
    list.innerHTML = `<ul class="nav-items">${items.map(navItem).join("")}</ul>`;
    return;
  }
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.a.author)) groups.set(it.a.author, []);
    groups.get(it.a.author).push(it);
  }
  const authors = [...groups.keys()].sort((x, y) =>
    (x === "Unknown") - (y === "Unknown") || collator.compare(x, y));
  const searching = !!state.navQ.trim();
  list.innerHTML = authors.map((au) => {
    const open = searching || !state.closedAuthors.has(au)
      || (state.current && state.current.author === au);
    const g = groups.get(au);
    return `<details class="nav-group" data-author="${esc(au)}" ${open ? "open" : ""}>
      <summary><span>${esc(au)}</span><span class="n">${g.length}</span></summary>
      <ul class="nav-items">${g.map(navItem).join("")}</ul>
    </details>`;
  }).join("");
}

function setNavOpen(open) {
  if (narrow()) {
    document.body.classList.toggle("nav-open", open);
    $("scrim").hidden = !open;
  } else {
    document.body.classList.toggle("nav-collapsed", !open);
    store.set("navCollapsed", !open);
  }
  $("nav-toggle").setAttribute("aria-expanded", open);
}

function navIsOpen() {
  return narrow() ? document.body.classList.contains("nav-open")
    : !document.body.classList.contains("nav-collapsed");
}

// ---------------------------------------------------------------- analysis page

function renderValue(v) {
  if (v === null || v === undefined || v === "") return `<span class="badge">—</span>`;
  if (typeof v === "string") {
    return isHttp(v) && !/\s/.test(v.trim())
      ? `<a href="${esc(v.trim())}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v);
  }
  if (Array.isArray(v)) {
    if (v.every((x) => x === null || typeof x !== "object")) return v.map(renderValue).join(", ");
    return `<ul class="link-list">${v.map((x) => `<li>${renderValue(x)}</li>`).join("")}</ul>`;
  }
  return `<table class="kv">${Object.entries(v).map(([k, x]) =>
    `<tr><td>${esc(k)}</td><td>${renderValue(x)}</td></tr>`).join("")}</table>`;
}

// `inputs:` as a table, one row per input (one line in the plot legend). The
// standard columns come first, in this order, then any other keys.
// mc_sample is a short name ("SUSY 200PU"); mc_path, the full DAS dataset name,
// turns it into a link to DAS.
const INPUT_COLS = [["label", "Label"], ["algo", "Algo"], ["mc_sample", "MC sample"], ["events", "Events"]];
const INPUT_HIDDEN = new Set(["mc_path"]);   // shown as the MC sample link

// A DAS dataset name looks like /Primary/Processed/TIER.
const DATASET_RE = /^\/[^/\s]+\/[^/\s]+\/[A-Z0-9-]+$/;
const dasUrl = (ds) => "https://cmsweb.cern.ch/das/request?input="
  + encodeURIComponent("dataset=" + ds) + "&instance=prod/global";

const filled = (v) => v !== undefined && v !== null && v !== "";

function mcCell(r) {
  const name = filled(r.mc_sample) ? r.mc_sample : null;
  const p = typeof r.mc_path === "string" ? r.mc_path.trim() : "";
  if (!p) return name === null ? "" : renderValue(name);
  const href = isHttp(p) ? p : DATASET_RE.test(p) ? dasUrl(p) : null;
  // Without a short name, fall back to the dataset's first part.
  const text = typeof name === "string" ? name : (DATASET_RE.test(p) ? p.split("/")[1] : p);
  return href
    ? `<a href="${esc(href)}" target="_blank" rel="noopener" title="${esc(p)}">${esc(text)}</a>`
    : `<span title="${esc(p)}">${esc(text)}</span>`;
}

function inputsPanel(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) return "";
  const rows = inputs.map((s) => (s && typeof s === "object" && !Array.isArray(s)) ? s : { label: s });
  const cols = INPUT_COLS.filter(([c]) => rows.some((r) => c in r || (c === "mc_sample" && "mc_path" in r)));
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!INPUT_HIDDEN.has(k) && !cols.some(([c]) => c === k)) {
        const h = k.replace(/_/g, " ");
        cols.push([k, h.charAt(0).toUpperCase() + h.slice(1)]);   // pile_up -> Pile up
      }
    }
  }
  const cell = (r, c) => {
    if (c === "mc_sample") return `<td class="nw">${mcCell(r)}</td>`;
    if (!(c in r)) return "<td></td>";
    const v = r[c];
    if (c === "events" && /^\d+$/.test(String(v).trim())) {
      return `<td class="num">${Number(String(v).trim()).toLocaleString("en-US")}</td>`;
    }
    return `<td class="${c === "label" ? "in-label" : c === "algo" ? "nw" : ""}">${renderValue(v)}</td>`;
  };
  const body = rows.map((r) => `<tr>${cols.map(([c]) => cell(r, c)).join("")}</tr>`).join("");
  return `<section class="panel"><h2>Inputs</h2><div class="table-wrap"><table class="inputs">
    ${cols.length ? `<tr>${cols.map(([c, h]) => `<th class="${c === "events" ? "num" : ""}">${esc(h)}</th>`).join("")}</tr>` : ""}
    ${body}
  </table></div></section>`;
}

// The standard selection variables, always shown in this order.
const CUT_VARS = [
  ["eta", "|η|"], ["z0", "|z<sub>0</sub>|"], ["d0", "|d<sub>0</sub>|"],
  ["pt", "p<sub>T</sub>"], ["lxy", "L<sub>xy</sub>"], ["lz", "L<sub>z</sub>"],
];

// `selection:` as a list of "variable  cut" rows, split evenly into up to
// three columns: the standard variables first ("no cut" if there is none), then
// any other cuts. Keys can be written any standard
// way (eta, pT, p_T, dxy, dz, ...).
const prettyCut = (s) => s.replace(/>=/g, "≥").replace(/<=/g, "≤").replace(/!=/g, "≠");

function selectionPanel(sel) {
  if (sel === null || sel === undefined || sel === "") return "";
  let body;
  if (typeof sel !== "object" || Array.isArray(sel)) {
    body = `<p>${renderValue(sel)}</p>`;
  } else {
    const byVar = new Map();
    const extra = [];
    for (const [k, v] of Object.entries(sel)) {
      const words = splitWords(k).map(canon);
      const v0 = words.length === 1 && CUT_VARS.some(([c]) => c === words[0]) ? words[0] : null;
      if (v0 && !byVar.has(v0)) byVar.set(v0, v);
      else extra.push([k, v]);
    }
    const row = (label, v) => {
      const none = v === undefined || v === null || v === "";
      const val = none ? "no cut"
        : typeof v === "string" ? esc(prettyCut(v)) : renderValue(v);
      return `<div class="cut-row${none ? " none" : ""}"><span class="cut-var">${label}</span><span class="cut-val">${val}</span></div>`;
    };
    // wireCuts() splits the rows into as many columns as fit the box.
    body = `<div class="cuts" role="list">
      ${CUT_VARS.map(([c, label]) => row(label, byVar.get(c))).join("")}
      ${extra.map(([k, v]) => row(esc(k), v)).join("")}
    </div>`;
  }
  return `<section class="panel"><h2>Selection cuts</h2>${body}</section>`;
}

function detailsPanel(meta) {
  const extra = Object.entries(meta).filter(([k]) => !KNOWN_KEYS.has(k));
  if (!extra.length) return "";
  return `<section class="panel"><h2>Details</h2><div class="table-wrap"><table class="kv">
    ${extra.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${renderValue(v)}</td></tr>`).join("")}
  </table></div></section>`;
}

function filesPanel(files) {
  if (!files.length) return "";
  // Always open; the list scrolls inside a box as tall as its neighbour.
  return `<section class="panel files"><h2>Files (${files.length})</h2><div class="file-box"><div class="file-scroll"><ul class="file-list">
    ${files.map((f) => `<li><a href="${esc(f.url)}" download>${esc(f.path)}</a><span class="size">${fmtSize(f.size)}</span></li>`).join("")}
  </ul></div><div class="file-fade" aria-hidden="true"></div></div></section>`;
}

// Split the selection-cut rows into as many columns as fit the box (each at
// least CUT_COL_MIN px wide), filled column by column and as evenly as
// possible: 8 cuts in a wide box are 4 columns of 2, in a narrower one 3/3/2.
// Re-split when the box resizes.
const CUT_COL_MIN = 160;
const CUT_COL_GAP = 32;     // keep in sync with .cuts gap in style.css
let cutsObserver = null;
function wireCuts() {
  if (cutsObserver) cutsObserver.disconnect();
  const el = document.querySelector(".cuts");
  if (!el) return;
  const rows = [...el.querySelectorAll(".cut-row")];
  const n = rows.length;
  let shown = 0;
  const layout = () => {
    const fit = Math.floor((el.clientWidth + CUT_COL_GAP) / (CUT_COL_MIN + CUT_COL_GAP));
    let per = Math.ceil(n / Math.max(1, Math.min(n, fit)));     // rows per column
    // Avoid a nearly empty last column (7 -> 3/3/1): use fewer, fuller columns (4/3).
    while (per < n && per - (n - per * (Math.ceil(n / per) - 1)) >= 2) per++;
    if (per === shown) return;
    shown = per;
    const cols = [];
    rows.forEach((row, i) => {
      const c = Math.floor(i / per);
      if (!cols[c]) { cols[c] = document.createElement("div"); cols[c].className = "cut-col"; }
      cols[c].appendChild(row);
    });
    el.replaceChildren(...cols);
  };
  cutsObserver = new ResizeObserver(layout);
  cutsObserver.observe(el);
  layout();
}

// Show the bottom fade on the Files box while there is more to scroll to.
let fileFadeObserver = null;
function wireFileFade() {
  if (fileFadeObserver) fileFadeObserver.disconnect();
  const box = document.querySelector(".panel.files");
  const list = box && box.querySelector(".file-scroll");
  if (!list) return;
  const update = () => box.classList.toggle("more", list.scrollTop + list.clientHeight < list.scrollHeight - 2);
  list.addEventListener("scroll", update, { passive: true });
  fileFadeObserver = new ResizeObserver(update);
  fileFadeObserver.observe(list);
  update();
}

function commonWords(plots) {
  // Filename words that split the plots into useful groups: in more than
  // one plot but not in all of them.
  const members = new Map();   // word -> indices of plots containing it
  plots.forEach((p, i) => {
    for (const w of new Set(p._words.map(canon))) {
      if (!members.has(w)) members.set(w, []);
      members.get(w).push(i);
    }
  });
  const seen = new Set();      // skip words selecting the same plots as one already shown
  return [...members.entries()]
    .filter(([w, ix]) => ix.length > 1 && ix.length < plots.length && w !== "vs" && !/^\d+$/.test(w))
    .sort((x, y) => y[1].length - x[1].length || x[0].length - y[0].length || collator.compare(x[0], y[0]))
    .filter(([, ix]) => {
      const key = ix.join(",");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 18)
    .map(([w]) => w);
}

function renderAnalysis() {
  const a = state.current;
  const meta = a.meta || {};
  const cmssw = typeof meta.cmssw === "string" ? meta.cmssw : "";
  const tags = a.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  const desc = typeof meta.description === "string" ? meta.description.trim() : "";
  const hasPdf = a.plots.some((p) => p.formats.pdf);
  const hasImg = a.plots.some((p) => IMAGE_EXTS.some((e) => p.formats[e]));
  const panels = [inputsPanel(meta.inputs), filesPanel(a.files), selectionPanel(meta.selection), detailsPanel(meta)]
    .filter(Boolean);
  a._common = commonWords(a.plots);

  $("main").innerHTML = `
    <article>
      <header class="a-head">
        <h1>${esc(a.title)}</h1>
        <div class="a-meta">
          <span>by <b>${esc(a.author)}</b></span>
          ${a.date ? `<span>${esc(a.date)}</span>` : ""}
          ${cmssw ? `<span><b class="mono">${esc(cmssw)}</b></span>` : ""}
          <span class="mono">${esc(a.id)}/</span>
        </div>
        ${tags ? `<div class="tags">${tags}</div>` : ""}
        ${a.error ? `<div class="banner">The analysis info file has a problem, so its details aren't shown: <code>${esc(a.error)}</code></div>` : ""}
        ${desc ? `<p class="desc">${esc(desc)}</p>` : ""}
      </header>
      ${panels.length ? `<div class="info-grid ${panels.length > 1 ? "two" : ""}">${panels.join("")}</div>` : ""}
      ${a.notes ? `<section class="panel notes"><div id="notes" class="md"></div></section>` : ""}
      <div class="plot-bar">
        <input id="plot-search" type="search" placeholder="Search plots, e.g. d0 vs η, pT, z0 zoom" autocomplete="off" aria-label="Search plots" value="${esc(state.q)}">
        ${hasPdf && hasImg ? `<div class="seg" role="group" aria-label="Plot format">
          <button data-fmt="pdf" aria-pressed="${state.fmt === "pdf"}">PDF</button>
          <button data-fmt="png" aria-pressed="${state.fmt === "png"}">PNG</button>
        </div>` : ""}
        <span id="plot-count" class="count"></span>
        <span class="spacer"></span>
        <button id="toggle-all" class="link-btn" hidden>Collapse all</button>
      </div>
      <div id="words" class="words"></div>
      <div id="sections"></div>
    </article>`;
  if (a.notes) renderNotes(a);
  wireFileFade();
  wireCuts();
  renderPlots();
}

async function renderNotes(a) {
  const el = $("notes");
  // Plain text straight away; swapped for formatted Markdown once the
  // libraries have loaded (or kept, if they can't be loaded).
  el.innerHTML = `<pre class="plain">${esc(a.notes.text)}</pre>`;
  if (!a.notes.markdown) return;
  try {
    await Promise.all([loadScript(LIBS.marked), loadScript(LIBS.purify)]);
  } catch (e) {
    return;
  }
  if (state.current !== a || !el.isConnected) return;
  el.innerHTML = window.DOMPurify.sanitize(window.marked.parse(a.notes.text));
  // Relative links/images in the notes point inside the analysis folder.
  const base = `analyses/${encodeURIComponent(a.id)}/`;
  const rel = (u) => u && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(u);
  for (const img of el.querySelectorAll("img[src]")) {
    if (rel(img.getAttribute("src"))) img.setAttribute("src", base + img.getAttribute("src"));
  }
  for (const link of el.querySelectorAll("a[href]")) {
    if (rel(link.getAttribute("href"))) link.setAttribute("href", base + link.getAttribute("href"));
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener");
  }
}

function renderWords() {
  const parsed = parseQuery(state.q);
  const words = state.current._common;
  const typed = new Set(parsed.tokens.map(canon));
  $("words").innerHTML = words.length ? `<span class="lbl">Filter:</span>` + words.map((w) =>
    `<button class="chip" data-word="${esc(w)}" aria-pressed="${typed.has(w)}">${symbol(w)}</button>`).join("") : "";
}

function displayExt(p) {
  const img = IMAGE_EXTS.find((e) => p.formats[e]);
  if (state.fmt === "png") return p.formats.png ? "png" : img || "pdf";
  return p.formats.pdf ? "pdf" : img;
}

function cardHTML(p, i) {
  // Thumbnails prefer a bitmap (fast); PDF-only plots are rendered lazily.
  const img = p.formats.png ? "png" : IMAGE_EXTS.find((e) => p.formats[e]);
  const thumb = img
    ? `<img loading="lazy" src="${esc(p.formats[img])}" alt="">`
    : `<span class="ph">PDF</span>`;
  const shown = displayExt(p);
  const fmts = Object.keys(p.formats).sort((x, y) => (x !== "pdf") - (y !== "pdf"))
    .map((e) => `<span class="fmt ${e === shown ? "on" : ""}">${esc(e.toUpperCase())}</span>`).join("");
  return `<button class="card" data-i="${i}" title="${esc(p.path)}">
    <div class="thumb" ${img ? "" : `data-pdf="${esc(p.formats.pdf)}"`}>${thumb}</div>
    <div class="cap"><span class="name">${esc(p.name)}</span><span class="fmts">${fmts}</span></div>
  </button>`;
}

function renderPlots() {
  const a = state.current;
  const parsed = parseQuery(state.q);
  state.shown = a.plots.filter((p) => matchWords(p._words, parsed));
  const n = state.shown.length, total = a.plots.length;
  $("plot-count").textContent = n === total ? `${total} plot${total === 1 ? "" : "s"}` : `${n} of ${total} plots`;
  renderWords();

  const sections = $("sections");
  if (!total) {
    sections.innerHTML = `<p class="empty">This analysis has no plots yet.</p>`;
    $("toggle-all").hidden = true;
    return;
  }
  if (!n) {
    sections.innerHTML = `<p class="empty">No plots match “${esc(state.q)}”.</p>`;
    $("toggle-all").hidden = true;
    return;
  }
  const byDir = new Map();
  state.shown.forEach((p, i) => {
    if (!byDir.has(p.dir)) byDir.set(p.dir, []);
    byDir.get(p.dir).push([p, i]);
  });
  const dirs = [...byDir.keys()].sort((x, y) => (x !== "") - (y !== "") || collator.compare(x, y));
  const allDirs = new Set(a.plots.map((p) => p.dir));
  const sectioned = allDirs.size > 1 || !allDirs.has("");
  const searching = !parsed.empty;

  sections.innerHTML = dirs.map((d) => {
    const cards = byDir.get(d).map(([p, i]) => cardHTML(p, i)).join("");
    if (!sectioned) return `<div class="grid">${cards}</div>`;
    const open = searching || !state.closedDirs.has(d);
    return `<details class="section" data-dir="${esc(d)}" ${open ? "open" : ""}>
      <summary>${esc(d ? d.split("/").join(" / ") : "Top level")} <span class="n">${byDir.get(d).length}</span></summary>
      <div class="grid">${cards}</div>
    </details>`;
  }).join("");
  const toggle = $("toggle-all");
  toggle.hidden = !sectioned || dirs.length < 2;
  toggle.textContent = dirs.every((d) => state.closedDirs.has(d)) ? "Expand all" : "Collapse all";
  observeThumbs();
}

// ---------------------------------------------------------------- PDF rendering

async function loadPdfJs() {
  await loadScript(LIBS.pdfjs);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
  return window.pdfjsLib;
}

// Render page 1 of a PDF to a canvas that fits boxW x boxH CSS pixels.
async function renderPdf(url, boxW, boxH) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ url }).promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const fit = Math.min(boxW / base.width, boxH / base.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const vp = page.getViewport({ scale: fit * dpr });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    canvas.dataset.cssW = Math.round(vp.width / dpr);
    canvas.dataset.cssH = Math.round(vp.height / dpr);
    return canvas;
  } finally {
    doc.destroy();
  }
}

let thumbObserver = null;
const pdfQueue = [];
let pdfActive = 0;

function observeThumbs() {
  if (thumbObserver) thumbObserver.disconnect();
  pdfQueue.length = 0;
  const els = document.querySelectorAll(".thumb[data-pdf]");
  if (!els.length) return;
  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbObserver.unobserve(e.target);
      pdfQueue.push(e.target);
    }
    pumpPdf();
  }, { rootMargin: "300px" });
  els.forEach((el) => thumbObserver.observe(el));
}

function pumpPdf() {
  while (pdfActive < PDF_CONCURRENCY && pdfQueue.length) {
    const el = pdfQueue.shift();
    if (!el.isConnected) continue;
    pdfActive++;
    el.innerHTML = `<span class="ph">Rendering…</span>`;
    renderPdf(el.dataset.pdf, el.clientWidth || 320, el.clientHeight || 240)
      .then((canvas) => { if (el.isConnected) el.replaceChildren(canvas); })
      .catch(() => { if (el.isConnected) el.innerHTML = `<span class="ph">PDF (no preview)</span>`; })
      .finally(() => { pdfActive--; pumpPdf(); });
  }
}

// ---------------------------------------------------------------- lightbox

let lbToken = 0;

async function showInLightbox(p) {
  const token = ++lbToken;
  const view = $("lb-view");
  const ext = displayExt(p);
  const url = p.formats[ext];
  if (ext !== "pdf") {
    view.innerHTML = `<img src="${esc(url)}" alt="${esc(p.name)}">`;
    return;
  }
  view.innerHTML = `<span class="ph">Rendering PDF…</span>`;
  try {
    const box = view.getBoundingClientRect();
    const canvas = await renderPdf(url, Math.max(box.width - 16, 200), Math.max(box.height - 16, 150));
    if (token !== lbToken) return;
    canvas.style.width = canvas.dataset.cssW + "px";
    canvas.style.height = canvas.dataset.cssH + "px";
    view.replaceChildren(canvas);
  } catch (e) {
    // pdf.js unavailable (e.g. CDN blocked): fall back to the browser's viewer.
    if (token === lbToken) view.innerHTML = `<iframe src="${esc(url)}" title="${esc(p.name)}"></iframe>`;
  }
}

function openPlot(i) {
  if (i < 0 || i >= state.shown.length) return;
  state.open = i;
  const p = state.shown[i];
  $("lb-title").textContent = p.path;
  $("lb-links").innerHTML = Object.keys(p.formats).sort((x, y) => (x !== "pdf") - (y !== "pdf"))
    .map((e) => `<a href="${esc(p.formats[e])}" target="_blank" rel="noopener">Open ${esc(e.toUpperCase())}</a>`).join("");
  $("lb-foot").textContent = `${i + 1} of ${state.shown.length}` + (p.dir ? `  ·  ${p.dir}/` : "");
  $("lb-prev").hidden = i === 0;
  $("lb-next").hidden = i === state.shown.length - 1;
  const wasHidden = $("lightbox").hidden;
  $("lightbox").hidden = false;
  if (wasHidden) $("lb-close").focus();
  showInLightbox(p);
  writeHash(false);
}

function closePlot() {
  if (state.open < 0) return;
  const card = document.querySelector(`.card[data-i="${state.open}"]`);
  state.open = -1;
  lbToken++;
  $("lightbox").hidden = true;
  $("lb-view").innerHTML = "";
  writeHash(false);
  if (card) card.focus();
}

// ---------------------------------------------------------------- welcome / help

function helpHTML() {
  const site = location.origin + location.pathname.replace(/[^/]*$/, "");
  return `<section class="help">
    <h2>Add your analysis</h2>
    <p>An analysis is just a folder of plots (PDF and/or PNG, in subfolders if you like).
      Everything below is optional except the plots.</p>
    <ol>
      <li><strong>Name your plots descriptively.</strong> Search works on folder and file names, e.g.
        <code>resolution/d0_res_vs_eta_mind0-0p2.pdf</code>. Searching <code>d0 vs eta</code> finds it.
        If a PDF and a PNG have the same name, they are shown as one plot (PDF by default).</li>
      <li><strong>Optional:</strong> add an <code>analysis.yaml</code> with title, author, date, CMSSW version,
        inputs and selection cuts, and a <code>notes.md</code> that is shown above the plots.
        Either answer a few questions and let
        <a href="contrib/make_analysis_yaml.py" download>make_analysis_yaml.py</a> write it:
        <pre>curl -O ${esc(site)}contrib/make_analysis_yaml.py -O ${esc(site)}contrib/check_analysis.py
python3 make_analysis_yaml.py my-analysis/</pre>
        or copy the <a href="contrib/analysis.yaml" download>template</a> and edit it by hand.</li>
      <li><strong>Optional: check it</strong> (<a href="contrib/check_analysis.py" download>check_analysis.py</a>, plain Python 3).
        It shows what the site will display and points out problems:
        <pre>curl -O ${esc(site)}contrib/check_analysis.py
python3 check_analysis.py my-analysis/</pre></li>
      <li><strong>Copy it</strong> (on lxplus; the folder name becomes the analysis id: letters, digits, <code>. _ -</code>):
        <pre>rsync -av my-analysis/ ${esc(UPLOAD_DIR)}/my-analysis/</pre>
        It appears here immediately. To update, copy again. To remove it, delete the folder.</li>
    </ol>
  </section>
  ${contactHTML()}`;
}

function contactHTML() {
  return `<section class="help" id="contact">
    <h2>Bugs, questions and changes</h2>
    <ul>
      <li><strong>Found a bug or have an idea?</strong>
        <a href="${esc(REPO)}/issues" target="_blank" rel="noopener">Open an issue on GitHub</a>.</li>
      <li><strong>Want to change the site?</strong> The code is at
        <a href="${esc(REPO)}" target="_blank" rel="noopener">${esc(REPO.replace(/^https?:\/\//, ""))}</a>;
        pull requests are welcome.</li>
      <li><strong>Contact:</strong> ${esc(CONTACT.name)},
        <a href="mailto:${esc(CONTACT.email)}">${esc(CONTACT.email)}</a></li>
    </ul>
  </section>`;
}

function renderWelcome() {
  const as = state.analyses.filter((a) => a.id);
  const authors = new Set(as.map((a) => a.author));
  const plots = as.reduce((n, a) => n + a.n_plots, 0);
  const recent = [...as].sort((x, y) => (y.date || "").localeCompare(x.date || "")).slice(0, 8);
  $("main").innerHTML = `<div class="welcome">
    <h1>L1TF Validation</h1>
    <p class="stats">${as.length} analys${as.length === 1 ? "is" : "es"} · ${authors.size} author${authors.size === 1 ? "" : "s"} · ${plots} plots</p>
    ${recent.length ? `<h2>Recently added</h2><ul class="recent">${recent.map((a) => `
      <li><a href="#a=${encodeURIComponent(a.id)}">${esc(a.title)}</a>
        <div class="s">${esc(a.author)} · ${esc(a.date)} · ${a.n_plots} plots</div></li>`).join("")}</ul>` : ""}
    ${helpHTML()}
  </div>`;
}

function renderHelp() {
  $("main").innerHTML = `<div class="welcome">${helpHTML()}</div>`;
  if (location.hash === "#contact") $("contact").scrollIntoView();
}

// ---------------------------------------------------------------- routing

async function loadAnalysis(id, h) {
  $("main").innerHTML = `<p class="empty">Loading…</p>`;
  let a;
  try {
    a = await getJSON(`${API}?action=get&id=${encodeURIComponent(id)}`);
  } catch (e) {
    state.current = null;
    $("main").innerHTML = `<div class="notice"><p><strong>Couldn't open “${esc(id)}”.</strong></p>
      <p>${esc(e.status === 404 ? "There's no analysis with that name. It may have been renamed or removed." : e.message)}</p></div>`;
    renderNav();
    return;
  }
  for (const p of a.plots) p._words = splitWords(p.path);
  state.current = a;
  state.q = h.q || "";
  state.fmt = h.fmt === "png" ? "png" : "pdf";
  state.closedDirs = new Set();
  state.open = -1;
  renderAnalysis();
  renderNav();
  $("main").focus({ preventScroll: true });
  window.scrollTo(0, 0);
  if (h.plot) {
    const i = state.shown.findIndex((p) => p.path === h.plot);
    if (i >= 0) openPlot(i);
  }
}

// The hash route() last handled. Following a #link fires both popstate and
// hashchange; this makes the second call a no-op.
let routedHash = null;

async function route() {
  if (location.hash === routedHash) return;
  routedHash = location.hash;
  const h = readHash();
  if (state.open >= 0 && !h.plot) {
    state.open = -1;
    $("lightbox").hidden = true;
  }
  if (h.help || !h.a) {
    state.current = null;
    h.help ? renderHelp() : renderWelcome();
    renderNav();
    return;
  }
  if (!state.current || state.current.id !== h.a) {
    await loadAnalysis(h.a, h);
    return;
  }
  // Same analysis: apply search / format / plot from the hash.
  state.q = h.q;
  state.fmt = h.fmt === "png" ? "png" : "pdf";
  $("plot-search").value = state.q;
  for (const b of document.querySelectorAll("[data-fmt]")) b.setAttribute("aria-pressed", b.dataset.fmt === state.fmt);
  renderPlots();
  if (h.plot) {
    const i = state.shown.findIndex((p) => p.path === h.plot);
    if (i >= 0) openPlot(i);
  }
}

function go(hash) {
  history.pushState(null, "", hash);
  route();
}

// ---------------------------------------------------------------- events

function bind() {
  $("nav-toggle").addEventListener("click", () => setNavOpen(!navIsOpen()));
  $("scrim").addEventListener("click", () => setNavOpen(false));

  let navTimer;
  $("nav-search").addEventListener("input", (e) => {
    clearTimeout(navTimer);
    navTimer = setTimeout(() => { state.navQ = e.target.value; renderNav(); }, 100);
  });

  document.querySelector(".nav-opts").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.group) { state.group = b.dataset.group; store.set("group", state.group); }
    if (b.dataset.sort) { state.sort = b.dataset.sort; store.set("sort", state.sort); }
    renderNav();
  });

  $("nav-list").addEventListener("click", (e) => {
    const b = e.target.closest(".nav-item[data-id]");
    if (!b) return;
    if (narrow()) setNavOpen(false);
    const h = new URLSearchParams();
    h.set("a", b.dataset.id);
    // Matched on plot names only: carry the search over to the plots.
    if (b.dataset.plotq && state.navQ.trim()) h.set("q", state.navQ.trim());
    go("#" + h.toString());
  });

  // <details> toggle events don't bubble; listen in the capture phase.
  $("nav-list").addEventListener("toggle", (e) => {
    const d = e.target;
    if (!d.matches || !d.matches(".nav-group") || state.navQ.trim()) return;
    if (d.open) state.closedAuthors.delete(d.dataset.author);
    else state.closedAuthors.add(d.dataset.author);
    store.set("closedAuthors", [...state.closedAuthors]);
  }, true);

  const main = $("main");
  let plotTimer;
  main.addEventListener("input", (e) => {
    if (e.target.id !== "plot-search") return;
    clearTimeout(plotTimer);
    plotTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      renderPlots();
      writeHash(false);
    }, 120);
  });
  main.addEventListener("click", (e) => {
    const card = e.target.closest(".card");
    if (card) return openPlot(Number(card.dataset.i));
    const chip = e.target.closest(".chip[data-word]");
    if (chip) {
      const w = chip.dataset.word;
      const parts = state.q.split(/\s+/).filter(Boolean);
      const same = (t) => splitWords(t).length === 1 && canon(splitWords(t)[0]) === w;
      const has = parts.some(same);
      state.q = (has ? parts.filter((t) => !same(t)) : [...parts, w]).join(" ");
      $("plot-search").value = state.q;
      renderPlots();
      writeHash(false);
      return;
    }
    const fmt = e.target.closest("[data-fmt]");
    if (fmt) {
      state.fmt = fmt.dataset.fmt;
      for (const b of document.querySelectorAll("[data-fmt]")) b.setAttribute("aria-pressed", b.dataset.fmt === state.fmt);
      renderPlots();
      writeHash(false);
      return;
    }
    if (e.target.id === "toggle-all") {
      const ds = [...document.querySelectorAll(".section")];
      const collapse = ds.some((d) => d.open);
      for (const d of ds) {
        d.open = !collapse;
        if (collapse) state.closedDirs.add(d.dataset.dir); else state.closedDirs.delete(d.dataset.dir);
      }
      e.target.textContent = collapse ? "Expand all" : "Collapse all";
    }
  });
  main.addEventListener("toggle", (e) => {
    const d = e.target;
    if (!d.matches || !d.matches(".section") || state.q) return;
    if (d.open) state.closedDirs.delete(d.dataset.dir);
    else state.closedDirs.add(d.dataset.dir);
  }, true);

  $("lb-close").addEventListener("click", closePlot);
  $("lb-prev").addEventListener("click", () => openPlot(state.open - 1));
  $("lb-next").addEventListener("click", () => openPlot(state.open + 1));
  $("lightbox").addEventListener("click", (e) => { if (e.target === $("lightbox")) closePlot(); });

  document.addEventListener("keydown", (e) => {
    if (state.open >= 0) {
      if (e.key === "Escape") closePlot();
      else if (e.key === "ArrowLeft") openPlot(state.open - 1);
      else if (e.key === "ArrowRight") openPlot(state.open + 1);
      return;
    }
    if (e.key === "Escape" && narrow() && navIsOpen()) setNavOpen(false);
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.key === "/" && !typing) {
      e.preventDefault();
      const box = $("plot-search") || $("nav-search");
      if (box === $("nav-search") && !navIsOpen()) setNavOpen(true);
      box.focus();
      box.select();
    }
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.open >= 0 && displayExt(state.shown[state.open]) === "pdf") showInLightbox(state.shown[state.open]);
    }, 200);
  });

  window.addEventListener("popstate", route);
  window.addEventListener("hashchange", route);
}

async function init() {
  if (store.get("navCollapsed", false) && !narrow()) document.body.classList.add("nav-collapsed");
  $("nav-toggle").setAttribute("aria-expanded", navIsOpen());
  bind();
  try {
    state.analyses = prepAnalyses((await getJSON(`${API}?action=list`)).analyses);
  } catch (e) {
    $("nav-list").innerHTML = "";
    $("main").innerHTML = `<div class="notice"><p><strong>Couldn't load the list of analyses.</strong></p>
      <p>${esc(e.message)}</p>
      <p>This page needs <code>api.php</code> to run, so it has to be served by a web server with PHP
      (EOS, or locally: <code>php -S localhost:8000 -t public</code>).</p></div>`;
    return;
  }
  renderNav();
  await route();
}

init();
