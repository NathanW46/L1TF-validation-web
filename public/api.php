<?php
// JSON API for the plot browser. The only PHP entry point.
//
//   api.php?action=list          every analysis (summary + plot paths)
//   api.php?action=get&id=NAME   one analysis: metadata, notes, plots, files

require __DIR__ . '/lib/yaml.php';
require __DIR__ . '/lib/scan.php';

date_default_timezone_set('Europe/Zurich');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-cache');
header('X-Content-Type-Options: nosniff');

function respond($data, $status = 200)
{
    http_response_code($status);
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
                            | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

$root = __DIR__ . '/analyses';
$action = isset($_GET['action']) ? (string)$_GET['action'] : 'list';

try {
    if ($action === 'list') {
        respond(['analyses' => list_analyses($root)]);
    }
    if ($action === 'get') {
        $id = isset($_GET['id']) ? (string)$_GET['id'] : '';
        $dir = "$root/$id";
        $real = realpath($dir);
        $realRoot = realpath($root);
        if (!preg_match(ID_RE, $id) || $id[0] === '.' || is_link($dir)
                || $real === false || $realRoot === false || !is_dir($real)
                || dirname($real) !== $realRoot) {
            respond(['error' => 'no such analysis'], 404);
        }
        respond(describe_analysis($root, $id, true));
    }
    respond(['error' => 'unknown action'], 400);
} catch (Throwable $e) {
    error_log('api.php: ' . $e);
    respond(['error' => 'internal error'], 500);
}
