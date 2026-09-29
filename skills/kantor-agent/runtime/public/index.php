<?php
declare(strict_types=1);

/*
 * Kantor Agent — server PHP (≥ 8.1, + mbstring), dijalankan lewat bin/kantor.sh:
 *   KANTOR_PROJECT=<project> KANTOR_STORAGE=<cache> php -S 127.0.0.1:8788 -t public public/index.php
 *   /kerja  /kerja/api/state  /kerja/api/ping  /kerja/assets/<file.js>
 * Setara dengan bin/serve-node.mjs (rute & JSON sama — bin/parity.mjs). Read-only: isi tool_result tidak pernah dibaca.
 */
date_default_timezone_set('UTC');
require dirname(__DIR__) . '/lib/php/Config.php';
require dirname(__DIR__) . '/lib/php/Office.php';
require dirname(__DIR__) . '/lib/php/Http.php';

$runtime = dirname(__DIR__);
$projectEnv = (string) getenv('KANTOR_PROJECT');
$project = realpath($projectEnv !== '' ? $projectEnv : (string) getcwd());
$storageEnv = (string) getenv('KANTOR_STORAGE');
$storage = $storageEnv !== '' ? rtrim($storageEnv, '/') : null;

$send = static function (int $status, array $headers, string $body = ''): never {
    http_response_code($status);
    foreach (KHttp::SECURITY_HEADERS + $headers as $k => $v) {
        header($k . ': ' . $v);
    }
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'HEAD') {
        echo $body;
    }
    exit;
};
$text = ['Content-Type' => 'text/plain; charset=utf-8'];

if ($project === false) {
    $send(500, $text, 'Folder project tidak ditemukan');
}
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method !== 'GET' && $method !== 'HEAD') {
    $send(405, $text + ['Allow' => 'GET, HEAD'], 'Metode tidak didukung');
}
if (!KHttp::hostAllowed(isset($_SERVER['HTTP_HOST']) ? (string) $_SERVER['HTTP_HOST'] : null, (string) getenv('KANTOR_ALLOWED_HOSTS'))) {
    $send(421, $text, 'Host tidak dikenal');
}
$path = rtrim((string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH), '/');

if ($path === '' || $path === '/index.php') {
    $send(302, ['Location' => '/kerja']);
}
if ($path === '/kerja/api/ping') {
    $send(200, ['Content-Type' => 'application/json; charset=utf-8', 'Cache-Control' => 'no-store'],
        (string) json_encode(['app' => 'kantor-agent', 'project' => substr(md5($project), 0, 12), 'runtime' => 'php']));
}
$cfg = KConfig::load($runtime, $project);
if ($path === '/kerja') {
    $page = (string) file_get_contents($runtime . '/views/page.html');
    $json = json_encode(KHttp::pageConfig($cfg), JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT | JSON_INVALID_UTF8_SUBSTITUTE);
    $send(200, ['Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => 'no-cache'], strtr($page, [
        '{{TITLE}}' => htmlspecialchars($cfg['title'], ENT_QUOTES),
        '{{CONFIG_SCRIPT}}' => '<script>window.KANTOR = ' . $json . ';</script>',
    ]));
}
if ($path === '/kerja/api/state') {
    $state = KOffice::build($project, $storage, $cfg, (int) floor(microtime(true) * 1000));
    $send(200, ['Content-Type' => 'application/json; charset=utf-8', 'Cache-Control' => 'no-store'],
        (string) json_encode($state, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE));
}
if (str_starts_with($path, '/kerja/assets/')) {
    $rel = rawurldecode(substr($path, strlen('/kerja/assets/')));
    $base = realpath(__DIR__ . '/assets');
    $f = str_contains($rel, "\0") ? false : realpath(__DIR__ . '/assets/' . $rel);
    if ($base === false || $f === false || !str_starts_with($f, $base . DIRECTORY_SEPARATOR) || !is_file($f)
        || strtolower(pathinfo($f, PATHINFO_EXTENSION)) !== 'js') {
        $send(404, []);
    }
    $etag = '"' . dechex((int) filemtime($f)) . '-' . dechex((int) filesize($f)) . '"';
    $h = ['Content-Type' => 'text/javascript; charset=utf-8', 'Cache-Control' => 'public, max-age=3600', 'ETag' => $etag];
    if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
        $send(304, $h);
    }
    $send(200, $h + ['Content-Length' => (string) filesize($f)], (string) file_get_contents($f));
}
$send(404, $text, 'Tidak ditemukan');
