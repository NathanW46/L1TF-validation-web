<?php
// php tests/php_parse.php file.yaml  ->  JSON, or "ERR <message>"
require __DIR__ . '/../public/lib/yaml.php';
try {
    $v = parse_yaml_subset(file_get_contents($argv[1]));
    echo json_encode($v === [] ? new stdClass() : $v, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
} catch (YamlError $e) {
    echo 'ERR ', $e->getMessage(), "\n";
}
