# Adding your analysis to the tracking plots site

An analysis is a folder of plots. Copy it into the site's `analyses/` folder on EOS and it
appears straight away. There's no build step and no registration.

## 1. Make the folder

```
my-analysis/                    <- the folder name becomes the analysis id in links
  analysis.yaml                 <- optional: title, author, date, CMSSW, samples, ...
  notes.md                      <- optional: shown above the plots (Markdown)
  efficiency/                   <- each folder of plots is a separate section on the webpage
    eff_vs_eta_mind0-0p2.pdf
    eff_vs_eta_mind0-0p2.png    <- same name as the PDF: shown as one plot
  resolution/
    d0_res_vs_eta.pdf
  efficiency.root               <- anything that isn't a plot is listed for download
```

- **Folder name:** letters, digits, `.`, `_` and `-` only.
- **Plots:** PDF, PNG, JPG, GIF or WebP. Subfolders become collapsible sections.
  SVG isn't supported: SVG files are ignored and never served, so save plots as PDF or PNG.
  - When a PDF and a PNG share a name, they're shown as one plot. The PDF is the default and
    there's a PDF/PNG switch.
  - Including PNGs makes the page load faster, because the site doesn't have to render a
    thumbnail for every PDF.
- **Names matter.** Search only looks at folder and file names. Names like
  `d0_res_vs_eta_mind0-0p2.pdf` are easy to find; `plot1.pdf` isn't. Search splits names on
  `_ - . /`, so the example above matches `d0`, `eta`, `mind0` and `d0 vs eta` (A before B).
  - Standard variable names are understood in any spelling: `η`/`eta`/`pseudorapidity`,
    `pT`/`p_T`/`transverse momentum`, `d0`/`d₀`/`dxy`/`impact parameter`, `z0`/`dz`,
    `phi`/`φ`, `Lxy`/`L_xy`, and `eff`/`efficiency`, `res`/`resolution`.

## 2. Optional: `analysis.yaml`

### CLI Guided 

```sh
curl -O https://<site>/contrib/make_analysis_yaml.py -O https://<site>/contrib/check_analysis.py
python3 make_analysis_yaml.py my-analysis/
```

It asks, in order:
- **About the analysis:** title, author, date, CMSSW version, tags, description.
- **Samples:** label, file path and number of events for each.
- **Selection cuts:** |η|, |z0|, |d0|, pT, Lxy, Lz, then any extra cuts (e.g. nstub).
- **Details:** anything else, e.g. "resolution method".

It then shows the result and asks before writing `my-analysis/analysis.yaml`.

Defaults:
- Press **Enter** to accept the `[default]` in brackets, or to skip a question.
- **Author** defaults to your name as set on your computer or lxplus account.
- **CMSSW** defaults to the release you set up with `cmsenv`.
- **Date** defaults to today.

Other things to know:
- **Cuts:** write them as they should read, e.g. `< 2.4` or `> 2 GeV`. A bare number like `2.4`
  doesn't say which way the cut goes. For the standard variables the script then offers the usual
  direction (`< 2.4` for |η|, `> 2` for pT, …); for other cuts it asks you to confirm or retype.
  `check_analysis.py` warns about bare-number cuts too.
- **Description:** type your text, finish with an empty line. A line with just `.` starts a
  new paragraph.
- **Editing later:** run it again. The values already in the file become the defaults, so
  you only retype what changed.
- **Quoting is automatic.** The output always reads back exactly as you typed it, including
  `#`, `:` and quotes. If `check_analysis.py` is in the same folder, the script also checks
  its own output with it.
- **Cancel** with Ctrl-C, or answer `n` at the end. Nothing is written until you confirm.

### Manual Creation

Download the template from the site (`contrib/analysis.yaml`). Every field is optional:

```yaml
title: Displaced tracking with PR391       # default: folder name
author: Your Name                          # default: Unknown (the menu groups by this)
date: 2026-10-27                           # default: date of the newest file
cmssw: CMSSW_15_1_0_pre3
tags: [displaced, efficiency]
description: >
  Description about the study.
samples:
  - label: Baseline
    path: DAS/path
selection:                                 # shown as a "Selection cuts" table
  pt: "> 2 GeV"
  eta: "< 2.4"
  d0: "< 10 cm"
  nstub: ">= 4"                            # extra cuts become extra rows
resolution method: rms                     # any other key goes in a Details table
```

The selection table always lists η, z0, d0, pT, Lxy and Lz, with "no cut" for any you
leave out. Keys can be written in any of the usual ways (`eta`, `pT`, `p_T`, `dxy`, `dz`, ...).

The site reads a simple subset of YAML:
- `key: value` lines,
- `- item` lists,
- `[a, b]` lists,
- `>` or `|` for multi-line text,
- `#` comments.

Put a value in quotes if it contains ` #` or starts with `> | [ { & * ! % @ " '`
(so cuts like `"> 2 GeV"` need quotes).

## 3. Optional: Check for errors

```sh
curl -O https://<site>/contrib/check_analysis.py      # plain Python 3, no packages needed
python3 check_analysis.py my-analysis/
```

This step is not so important, but it shows what the site will display and points out problems. 
Fix anything marked `ERROR`.

## 4. Copy it

On lxplus (you need write access to the folder; ask the site owner):

```sh
rsync -av my-analysis/ /eos/user/n/nwhittin/www/public/analyses/my-analysis/
```

Or use other methods such as CERNBox or scp, into the same `www/public/analyses/` folder.


## Problems or ideas?

- Bugs and feature requests: open an issue at
  https://github.com/NathanW46/L1TF-validation-web/issues
- Changes to the site itself: pull requests to https://github.com/NathanW46/L1TF-validation-web
- Contact: Nathan Whittington, nathan.whittington@cern.ch
