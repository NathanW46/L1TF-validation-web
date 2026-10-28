<?php
// Router for PHP's built-in server, for local preview only:
//
//   php -S localhost:8000 -t public dev_router.php
//
// The built-in server ignores .htaccess, so this applies the same rules the
// .htaccess files apply on EOS: lib/ and dotfiles are private, nothing under
// analyses/ is executed, contrib/ downloads are served as plain text.

$path = rawurldecode(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
$file = $_SERVER['DOCUMENT_ROOT'] . $path;

function deny()
{
    http_response_code(403);
    header('Content-Type: text/plain');
    echo "Forbidden\n";
    return true;
}

if (strpos($path, '..') !== false || preg_match('#(^|/)\.#', $path)) {
    return deny();
}
if (preg_match('#^/lib(/|$)#', $path)) {
    return deny();
}
if (preg_match('#^/analyses/.*\.(php\d?|phtml|phar|phps|cgi|pl|fcgi|svgz?)$#i', $path)) {
    return deny();
}
if (preg_match('#^/(analyses|contrib)/.*\.(py|sh|yaml|yml|html?|xhtml|shtml)$#i', $path) && is_file($file)) {
    header('Content-Type: text/plain; charset=utf-8');
    readfile($file);
    return true;
}
return false;   // let the built-in server handle it
