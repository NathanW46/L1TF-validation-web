# L1TF-validation-web

A general plot browser for the EOSweb. People can drop analysis folders (PDF/PNG plots,
plus an optional `analysis.yaml` and `notes.md`) into `www/public/analyses/`. `api.php` scans that
folder on every request, so there's no index or build step. Adding a folder is the only step for contribution.

For contributors, see **[CONTRIBUTING.md](CONTRIBUTING.md)**. It's also summarised on the
site under "How to add your analysis".

- **Code / issues:** https://github.com/NathanW46/L1TF-validation-web
- **Contact:** Nathan Whittington, nathan.whittington@cern.ch

Both are set as `CONTACT` and `REPO` at the top of `public/assets/app.js` and shown under
"Report a bug / contact" in the site's menu.

```
public/                     the website (the folder the webeos site points at)
  index.html                page shell
  assets/app.js, style.css  the browser app (vanilla JS; pdf.js, marked and DOMPurify loaded from cdnjs when needed)
  api.php                   JSON API: ?action=list, ?action=get&id=NAME
  lib/yaml.php              YAML-subset parser (port of the one in contrib/check_analysis.py)
  lib/scan.php              finds analyses, groups plots by name, lists other files
  lib/.htaccess             lib/ is not web-accessible
  contrib/                  downloads for contributors: check_analysis.py (validator),
                            make_analysis_yaml.py (interactive analysis.yaml writer),
                            analysis.yaml (template)
  analyses/.htaccess        uploaded content is never executed
  analyses/*                the analyses (contributors' folders; not part of the code)
dev_router.php              makes `php -S` apply the .htaccess rules locally
tests/                      parser fixtures + API smoke tests
```

## Run it locally

Requires php

```sh
php -S localhost:8000 -t public dev_router.php        # then open http://localhost:8000 in browser
```

`public/analyses/` holds all analyses. Add your own folders there to display them for others.

## Test

```sh
tests/run_tests.sh
```

This checks:
- both YAML parsers against `tests/yaml_fixtures/`,
- `make_analysis_yaml.py`, driven with scripted answers (awkward values, re-running on an
  existing file, cancelling); see `tests/test_make_analysis_yaml.py`,
- `php -l` on every PHP file,
- about 20 API checks on a temporary copy of the site with broken analyses added: bad YAML,
  bad folder name, symlinks, path traversal, an uploaded `.php` and `.svg`.

`python3 tests/check_fixtures.py --no-php` runs the Python parser on its own.

**Changing the YAML rules:** edit both `public/contrib/check_analysis.py` and
`public/lib/yaml.php` the same way. Add a fixture: a `.yaml` plus the expected `.json`, or a
`.err` for invalid input. Then run the tests.

## Notes on access

The repo is cloned into `/eos/user/n/nwhittin/www`, and the CERN Web Services portal points the
site at `/eos/user/n/nwhittin/www/public`, so only `public/` is served (not the README, tests,
etc.). Updating the code never touches the analyses in `public/analyses/`.

Contributors copy their folders into `/eos/user/n/nwhittin/www/public/analyses`. This path is
`UPLOAD_DIR` at the top of `public/assets/app.js` (shown on the site's help page) and is also
in CONTRIBUTING.md; keep them in sync if it moves.

`public/analyses` should be accessible to group members, as defined in eosweb.

## Notes

- **Search uses only paths and filenames.** Each name is split into words on `/ _ - .`. Every
  typed word must match the start of a word, or be another name for the same variable.
  The aliases (η/eta, p_T/pT, dxy/d0, dz/z0, efficiency/eff, …) are `ALIASES` and `normText`
  at the top of the search section in `app.js`; the filter chips show them as symbols. `A vs B` also requires A before B; when the name
  contains `vs`, A must be before it and B after it. The left-menu search covers analysis
  titles, authors and tags, plus plot names across all analyses.
- **PDF thumbnails** are rendered in the browser with pdf.js, three at a time, as they scroll
  into view. A PNG with the same name is used instead when it exists.
- **Limits per analysis:** 5000 files and 8 folder levels. Hidden files and symlinks are ignored.
- **Scanning cost:** `api.php?action=list` reads every analysis folder on each page load. This should be fine for
  some small number of analyses. Note for later: if this gets slow, maybe add some sort of cache in `lib/scan.php`?
