<?php
// Discovers analyses under analyses/ and lists their plots and files.
// The folder rules mirror scan() in contrib/check_analysis.py.

const ID_RE = '/^[A-Za-z0-9._-]+$/';
const PLOT_EXTS = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp'];
// Not shown at all (an SVG opened directly could run scripts on this site).
const SKIP_EXTS = ['svg', 'svgz'];
const META_FILES = ['analysis.yaml', 'analysis.yml'];
const NOTES_FILES = ['notes.md', 'notes.txt'];
const MAX_DEPTH = 8;
const MAX_FILES = 5000;

function url_path($rel)
{
    return implode('/', array_map('rawurlencode', explode('/', $rel)));
}

// Walk one analysis folder. Returns plots (stem => [ext => relpath]),
// files (relpath => size), the newest mtime, and the metadata / notes
// filenames found at the top level.
function scan_analysis($dir)
{
    $out = ['plots' => [], 'files' => [], 'newest' => 0, 'meta' => null, 'notes' => null];
    $count = 0;
    $stack = [['', 0]];
    while ($stack) {
        list($rel, $depth) = array_pop($stack);
        $abs = $rel === '' ? $dir : "$dir/$rel";
        $names = @scandir($abs);
        if ($names === false) {
            continue;
        }
        foreach ($names as $name) {
            if ($name === '' || $name[0] === '.') {
                continue;
            }
            $path = "$abs/$name";
            $relpath = $rel === '' ? $name : "$rel/$name";
            if (is_link($path)) {
                continue;
            }
            if (is_dir($path)) {
                if ($depth + 1 <= MAX_DEPTH) {
                    $stack[] = [$relpath, $depth + 1];
                }
                continue;
            }
            if (!is_file($path)) {
                continue;
            }
            $dotpos = strrpos($name, '.');
            if ($dotpos !== false && in_array(strtolower(substr($name, $dotpos + 1)), SKIP_EXTS, true)) {
                continue;
            }
            if (++$count > MAX_FILES) {
                return $out;
            }
            $out['newest'] = max($out['newest'], (int)@filemtime($path));
            $lower = strtolower($name);
            if ($rel === '' && in_array($lower, META_FILES, true)) {
                $out['meta'] = $name;
                continue;
            }
            if ($rel === '' && in_array($lower, NOTES_FILES, true)) {
                $out['notes'] = $name;
                continue;
            }
            $dot = strrpos($relpath, '.');
            $slash = strrpos($relpath, '/');
            $ext = ($dot !== false && ($slash === false || $dot > $slash))
                ? strtolower(substr($relpath, $dot + 1)) : '';
            if (in_array($ext, PLOT_EXTS, true)) {
                $out['plots'][substr($relpath, 0, $dot)][$ext] = $relpath;
            } else {
                $out['files'][$relpath] = (int)@filesize($path);
            }
        }
    }
    return $out;
}

// [meta array, error string|null]
function load_meta($dir, $file)
{
    if ($file === null) {
        return [[], null];
    }
    $text = @file_get_contents("$dir/$file");
    if ($text === false) {
        return [[], "$file could not be read"];
    }
    if (!preg_match('//u', $text)) {
        return [[], "$file is not UTF-8 text"];
    }
    try {
        return [parse_yaml_subset($text), null];
    } catch (YamlError $e) {
        return [[], "$file, " . $e->getMessage()];
    }
}

function meta_str($meta, $key)
{
    return (isset($meta[$key]) && is_string($meta[$key]) && trim($meta[$key]) !== '')
        ? trim($meta[$key]) : null;
}

// Summary (for the menu) or full description (for the analysis page) of
// one analysis folder.
function describe_analysis($root, $id, $full)
{
    $dir = "$root/$id";
    $scan = scan_analysis($dir);
    list($meta, $error) = load_meta($dir, $scan['meta']);

    $tags = $meta['tags'] ?? [];
    if (is_string($tags)) {
        $tags = [$tags];
    }
    $tags = is_array($tags) ? array_values(array_filter($tags, 'is_string')) : [];

    $stems = array_keys($scan['plots']);
    usort($stems, 'strnatcasecmp');

    $info = [
        'id' => $id,
        'title' => meta_str($meta, 'title') ?? $id,
        'author' => meta_str($meta, 'author') ?? 'Unknown',
        'date' => meta_str($meta, 'date') ?? ($scan['newest'] ? date('Y-m-d', $scan['newest']) : ''),
        'tags' => $tags,
        'n_plots' => count($stems),
        'error' => $error,
    ];
    if (!$full) {
        $info['plots'] = $stems;
        return $info;
    }

    $base = 'analyses/' . rawurlencode($id) . '/';
    $plots = [];
    foreach ($stems as $stem) {
        $slash = strrpos($stem, '/');
        $formats = [];
        foreach ($scan['plots'][$stem] as $ext => $rel) {
            $formats[$ext] = $base . url_path($rel);
        }
        $plots[] = [
            'path' => $stem,
            'dir' => $slash === false ? '' : substr($stem, 0, $slash),
            'name' => $slash === false ? $stem : substr($stem, $slash + 1),
            'formats' => $formats,
        ];
    }
    $files = [];
    $rels = array_keys($scan['files']);
    usort($rels, 'strnatcasecmp');
    foreach ($rels as $rel) {
        $files[] = ['path' => $rel, 'url' => $base . url_path($rel), 'size' => $scan['files'][$rel]];
    }

    $notes = null;
    if ($scan['notes'] !== null) {
        $text = @file_get_contents("$dir/{$scan['notes']}");
        if ($text !== false && preg_match('//u', $text)) {
            $notes = ['text' => $text, 'markdown' => strtolower(substr($scan['notes'], -3)) === '.md'];
        }
    }

    $info['meta'] = $meta ? $meta : new stdClass();
    $info['notes'] = $notes;
    $info['plots'] = $plots;
    $info['files'] = $files;
    return $info;
}

function list_analyses($root)
{
    $out = [];
    $names = @scandir($root);
    if ($names === false) {
        return $out;
    }
    foreach ($names as $name) {
        if ($name === '' || $name[0] === '.') {
            continue;
        }
        $path = "$root/$name";
        if (is_link($path) || !is_dir($path)) {
            continue;
        }
        if (!preg_match(ID_RE, $name)) {
            $out[] = ['id' => null, 'title' => $name, 'author' => 'Unknown', 'date' => '',
                      'tags' => [], 'n_plots' => 0, 'plots' => [],
                      'error' => "folder name may only contain letters, digits, '.', '_' and '-'"];
            continue;
        }
        $out[] = describe_analysis($root, $name, false);
    }
    return $out;
}
