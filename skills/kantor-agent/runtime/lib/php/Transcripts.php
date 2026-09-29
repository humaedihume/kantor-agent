<?php
declare(strict_types=1);

require_once __DIR__ . '/Util.php';

/**
 * Ringkasan transkrip Claude Code (JSONL) secara inkremental — hanya metadata tool_use & potongan teks assistant.
 * Isi tool_result TIDAK PERNAH dibaca. Port Node: lib/node/transcripts.mjs (harus identik — dicek bin/parity.mjs).
 */
final class KTranscripts
{
    private const CACHE_V = 2;
    private const HEAD_MAX = 1024; // sidik jari awal berkas: berkas diganti (bukan ditambah) → ringkasan dibuat ulang
    private const EVENTS_KEEP = 40;
    private const SEGS_KEEP = 20;
    private const STOPS_KEEP = 80;
    private const FILES_KEEP = 12;
    private const TODOS_KEEP = 40;

    private ?string $cacheDir;

    /** @param array<string,mixed> $cfg */
    public function __construct(private string $projectDir, ?string $storageDir, private array $cfg)
    {
        $this->cacheDir = $storageDir !== null ? $storageDir . '/cache' : null;
    }

    public static function root(string $projectDir): string
    {
        $base = (string) getenv('CLAUDE_CONFIG_DIR');
        if ($base === '') {
            $home = (string) getenv('HOME');
            if ($home === '' && function_exists('posix_getpwuid')) {
                $home = (string) (posix_getpwuid(posix_geteuid())['dir'] ?? '');
            }
            $base = rtrim($home, '/') . '/.claude';
        }
        return rtrim($base, '/') . '/projects/' . preg_replace('/[^a-zA-Z0-9]/', '-', $projectDir);
    }

    /** @return array{exists:bool,runs:list<array<string,mixed>>,mains:list<array<string,mixed>>} */
    public function scan(int $nowSec): array
    {
        $root = self::root($this->projectDir);
        if (!is_dir($root)) {
            return ['exists' => false, 'runs' => [], 'mains' => []];
        }
        $cutoff = $nowSec - (int) $this->cfg['window_days'] * 86400;
        $mainFiles = [];
        foreach (KUtil::globDir($root, '.jsonl') as $f) {
            $mt = KUtil::mtime($f);
            if ($mt >= $cutoff) {
                $mainFiles[] = [$f, $mt];
            }
        }
        usort($mainFiles, static fn($a, $b) => ($b[1] <=> $a[1]) ?: strcmp($a[0], $b[0]));
        $mainFiles = array_slice($mainFiles, 0, (int) $this->cfg['mains_max']);
        $mains = [];
        foreach ($mainFiles as [$f]) {
            $mains[] = $this->summarize($f) + ['session' => basename($f, '.jsonl')];
        }

        $metas = [];
        foreach (KUtil::globDir($root, '') as $d) {
            if (!is_dir($d)) {
                continue;
            }
            foreach (KUtil::globDir($d . '/subagents', '.meta.json') as $m) {
                $metas[] = [$m, basename($d)];
            }
            foreach (KUtil::globDir($d . '/subagents/workflows', '') as $wf) {
                foreach (KUtil::globDir($wf, '.meta.json') as $m) {
                    $metas[] = [$m, basename($d)];
                }
            }
        }
        usort($metas, static fn($a, $b) => strcmp($a[0], $b[0]));
        $runs = [];
        foreach ($metas as [$metaFile, $session]) {
            $jsonl = substr($metaFile, 0, -strlen('.meta.json')) . '.jsonl';
            $name = basename($jsonl, '.jsonl');
            if (!str_starts_with($name, 'agent-') || !is_file($jsonl) || KUtil::mtime($jsonl) < $cutoff) {
                continue;
            }
            $meta = json_decode((string) @file_get_contents($metaFile), true);
            $meta = is_array($meta) && ($meta === [] || !array_is_list($meta)) ? $meta : [];
            $type = is_string($meta['agentType'] ?? null) && trim($meta['agentType']) !== '' ? KUtil::clip(trim($meta['agentType']), 40) : 'general-purpose';
            $desc = is_string($meta['description'] ?? null) ? KUtil::safeLine($meta['description'], 140) : '';
            $sum = $this->summarize($jsonl);
            if ($sum['started'] === null) {
                continue;
            }
            $runs[] = $sum + [
                'id' => substr($name, 6),
                'session' => $session,
                'agentType' => $type,
                'description' => $desc,
                'parentAgent' => is_string($meta['parentAgentId'] ?? null) ? $meta['parentAgentId'] : null,
            ];
        }
        return ['exists' => true, 'runs' => $runs, 'mains' => $mains];
    }

    /** @return array<string,mixed> */
    private static function fresh(): array
    {
        return ['v' => self::CACHE_V, 'offset' => 0, 'headLen' => 0, 'head' => '', 'started' => null, 'updated' => null, 'tools' => 0,
            'tokens' => ['in' => 0, 'out' => 0, 'cache' => 0], 'lastMsgId' => null, 'events' => [], 'lastKind' => null,
            'limit' => null, 'files' => [], 'todos' => null, 'todosAt' => null, 'todoSource' => null, 'tasks' => [],
            'taskSeq' => 0, 'segs' => [], 'stops' => []];
    }

    /** md5 dari n byte pertama berkas ('' bila n = 0 atau gagal dibaca) */
    private static function headOf(string $file, int $n): string
    {
        if ($n <= 0) {
            return '';
        }
        $fh = @fopen($file, 'rb');
        if ($fh === false) {
            return '';
        }
        $b = (string) fread($fh, $n);
        fclose($fh);
        return strlen($b) === $n ? md5($b) : '';
    }

    /** @return array<string,mixed> */
    public function summarize(string $file): array
    {
        $size = (int) @filesize($file);
        $cacheFile = $this->cacheDir !== null ? $this->cacheDir . '/p-' . md5($file) . '.json' : null;
        $s = $cacheFile !== null && is_file($cacheFile) ? json_decode((string) @file_get_contents($cacheFile), true) : null;
        if (!is_array($s) || ($s['v'] ?? 0) !== self::CACHE_V || !is_int($s['offset'] ?? null) || $s['offset'] < 0 || $s['offset'] > $size
            || !is_int($s['headLen'] ?? null) || $s['headLen'] < 0 || $s['headLen'] > $size || self::headOf($file, $s['headLen']) !== ($s['head'] ?? null)) {
            $s = self::fresh();
        }
        if ($s['offset'] < $size) {
            $fh = @fopen($file, 'rb');
            if ($fh !== false) {
                fseek($fh, $s['offset']);
                $pos = $s['offset'];
                while (($line = fgets($fh)) !== false) {
                    if (!str_ends_with($line, "\n")) {
                        break; // baris belum lengkap ditulis — dibaca lagi nanti
                    }
                    $pos += strlen($line);
                    $row = json_decode($line, true);
                    if (is_array($row) && ($row === [] || !array_is_list($row))) {
                        $this->consume($s, $row);
                    }
                }
                fclose($fh);
                $s['offset'] = $pos;
                $s['headLen'] = min($size, self::HEAD_MAX);
                $s['head'] = self::headOf($file, $s['headLen']);
            }
            if ($cacheFile !== null && (is_dir(dirname($cacheFile)) || @mkdir(dirname($cacheFile), 0775, true))) {
                @file_put_contents($cacheFile, json_encode($s, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE), LOCK_EX);
            }
        }
        return [
            'started' => $s['started'], 'updated' => $s['updated'], 'tools' => $s['tools'],
            'tokens' => $s['tokens']['in'] + $s['tokens']['out'] + $s['tokens']['cache'],
            'events' => $s['events'], 'lastKind' => $s['lastKind'], 'limit' => $s['limit'], 'files' => $s['files'],
            'todos' => $s['todos'], 'todosAt' => $s['todosAt'], 'todoSource' => $s['todoSource'], 'segs' => $s['segs'],
            'stops' => $s['stops'],
        ];
    }

    /** @param array<string,mixed> $s @param array<string,mixed> $row */
    private function consume(array &$s, array $row): void
    {
        $type = $row['type'] ?? '';
        $t = is_string($row['timestamp'] ?? null) && KUtil::tsMs($row['timestamp']) !== null ? $row['timestamp'] : '';
        $msg = $row['message'] ?? null;
        if ($type !== 'user' && $type !== 'assistant') {
            return;
        }
        if ($t !== '') {
            $s['started'] ??= $t;
            $s['updated'] = $t;
        }
        if (!is_array($msg)) {
            return;
        }
        $content = $msg['content'] ?? '';
        if ($t !== '') {
            $n = count($s['segs']);
            if ($n === 0) {
                $s['segs'][] = [$t, null];
            } elseif ($s['segs'][$n - 1][1] !== null && ($type === 'assistant' || is_string($content))) {
                if (KUtil::tsMs($t) - KUtil::tsMs($s['segs'][$n - 1][1]) <= (int) $this->cfg['cooldown'] * 1000) {
                    $s['segs'][$n - 1][1] = null;
                } else {
                    $s['segs'][] = [$t, null];
                    if (count($s['segs']) > self::SEGS_KEEP) {
                        array_shift($s['segs']);
                    }
                }
            }
        }
        if ($type === 'user') {
            if (is_string($content)) {
                if (empty($row['isMeta']) && !str_starts_with(ltrim($content), '<') && ($row['isSidechain'] ?? false) === false) {
                    $this->push($s, $t, 'user', 'Instruksi dari user', null);
                }
                $s['lastKind'] = 'user';
            } elseif (is_array($content) && $s['lastKind'] !== 'handback') {
                $s['lastKind'] = 'result';
            }
            return;
        }
        $id = is_string($msg['id'] ?? null) ? $msg['id'] : '';
        if ($id !== '' && $id !== $s['lastMsgId'] && is_array($msg['usage'] ?? null)) {
            $u = $msg['usage'];
            $s['tokens']['in'] += self::int($u['input_tokens'] ?? 0);
            $s['tokens']['out'] += self::int($u['output_tokens'] ?? 0);
            $s['tokens']['cache'] += self::int($u['cache_read_input_tokens'] ?? 0) + self::int($u['cache_creation_input_tokens'] ?? 0);
            $s['lastMsgId'] = $id;
        }
        $hasTool = false;
        $hasText = false;
        $handback = false;
        foreach (is_array($content) ? $content : [] as $b) {
            if (!is_array($b)) {
                continue;
            }
            $bt = $b['type'] ?? '';
            if ($bt === 'tool_use') {
                $hasTool = true;
                $name = is_string($b['name'] ?? null) ? $b['name'] : '?';
                $in = is_array($b['input'] ?? null) && ($b['input'] === [] || !array_is_list($b['input'])) ? $b['input'] : [];
                $s['tools']++;
                [$text, $path] = $this->describeTool($name, $in);
                if ($path !== null && in_array($name, ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'], true)) {
                    $s['files'] = array_values(array_filter($s['files'], static fn($f) => $f !== $path));
                    $s['files'][] = $path;
                    if (count($s['files']) > self::FILES_KEEP) {
                        array_shift($s['files']);
                    }
                }
                if ($name === 'TaskStop' && $t !== '') {
                    $tid = is_string($in['task_id'] ?? null) ? $in['task_id'] : (is_string($in['shell_id'] ?? null) ? $in['shell_id'] : '');
                    if (preg_match('/^[A-Za-z0-9_-]{1,64}$/', $tid)) {
                        $s['stops'][] = [$tid, $t];
                        if (count($s['stops']) > self::STOPS_KEEP) {
                            array_shift($s['stops']);
                        }
                    }
                }
                $this->todo($s, $name, $in, $t);
                if ($name === 'SubagentHandback') {
                    $handback = true;
                }
                $this->push($s, $t, 'tool', $text, $name);
            } elseif ($bt === 'text') {
                $txt = is_string($b['text'] ?? null) ? trim($b['text']) : '';
                if ($txt === '') {
                    continue;
                }
                $hasText = true;
                if (preg_match('/(usage limit|rate limit|limit reached|resets? (at|in))/i', $txt) && mb_strlen($txt) < 400) {
                    $s['limit'] = KUtil::clip(KUtil::redact($txt), 200);
                }
                $this->push($s, $t, 'text', KUtil::safeLine($txt, 180), null);
            }
        }
        $stop = is_string($msg['stop_reason'] ?? null) ? $msg['stop_reason'] : '';
        if ($handback) {
            $s['lastKind'] = 'handback';
        } elseif ($hasTool) {
            $s['lastKind'] = 'tool';
        } elseif ($hasText) {
            $s['lastKind'] = $stop === 'end_turn' ? 'final' : 'text';
        } else {
            $s['lastKind'] ??= 'thinking';
        }
        if ($hasTool) {
            $s['limit'] = null;
        }
        $n = count($s['segs']);
        if ($stop === 'end_turn' && $t !== '' && $n > 0 && $s['segs'][$n - 1][1] === null) {
            $s['segs'][$n - 1][1] = $t;
        }
    }

    /** @param array<string,mixed> $s @param array<string,mixed> $in */
    private function todo(array &$s, string $name, array $in, string $t): void
    {
        if ($name === 'TodoWrite' && is_array($in['todos'] ?? null)) {
            $items = [];
            foreach ($in['todos'] as $td) {
                if (!is_array($td)) {
                    continue;
                }
                $text = is_string($td['content'] ?? null) ? $td['content'] : (is_string($td['subject'] ?? null) ? $td['subject'] : '');
                if (trim($text) === '') {
                    continue;
                }
                $items[] = ['text' => KUtil::safeLine($text, 120), 'status' => self::todoStatus($td['status'] ?? null)];
                if (count($items) >= self::TODOS_KEEP) {
                    break;
                }
            }
            $s['todos'] = $items;
            $s['todosAt'] = $t;
            $s['todoSource'] = 'TodoWrite';
            return;
        }
        if ($name === 'TaskCreate') {
            $subject = is_string($in['subject'] ?? null) ? $in['subject'] : (is_string($in['description'] ?? null) ? $in['description'] : '');
            $s['taskSeq']++;
            if (trim($subject) === '') {
                return;
            }
            $s['tasks']['#' . $s['taskSeq']] = ['text' => KUtil::safeLine($subject, 120), 'status' => 'pending'];
            if (count($s['tasks']) > self::TODOS_KEEP) {
                array_shift($s['tasks']);
            }
        } elseif ($name === 'TaskUpdate') {
            $tid = $in['taskId'] ?? $in['id'] ?? null;
            $tid = is_string($tid) || is_int($tid) ? '#' . $tid : '';
            if (!isset($s['tasks'][$tid])) {
                return;
            }
            if (($in['status'] ?? null) === 'deleted') {
                unset($s['tasks'][$tid]);
            } else {
                if (is_string($in['status'] ?? null)) {
                    $s['tasks'][$tid]['status'] = self::todoStatus($in['status']);
                }
                if (is_string($in['subject'] ?? null) && trim($in['subject']) !== '') {
                    $s['tasks'][$tid]['text'] = KUtil::safeLine($in['subject'], 120);
                }
            }
        } else {
            return;
        }
        $s['todos'] = array_values($s['tasks']);
        $s['todosAt'] = $t;
        $s['todoSource'] = 'Task';
    }

    private static function todoStatus(mixed $v): string
    {
        return in_array($v, ['pending', 'in_progress', 'completed'], true) ? $v : 'pending';
    }

    private static function int(mixed $v): int
    {
        return is_int($v) ? $v : (is_float($v) && is_finite($v) ? (int) $v : 0);
    }

    /** @param array<string,mixed> $s */
    private function push(array &$s, string $t, string $kind, string $text, ?string $tool): void
    {
        if ($t === '') {
            return;
        }
        $s['events'][] = ['t' => $t, 'kind' => $kind, 'text' => $text, 'tool' => $tool];
        if (count($s['events']) > self::EVENTS_KEEP) {
            array_splice($s['events'], 0, count($s['events']) - self::EVENTS_KEEP);
        }
    }

    /** @param array<string,mixed> $in @return array{0:string,1:?string} */
    private function describeTool(string $name, array $in): array
    {
        $str = static fn($v): string => is_string($v) ? $v : (is_int($v) ? (string) $v : '');
        $path = null;
        foreach (['file_path', 'notebook_path'] as $k) {
            if (is_string($in[$k] ?? null) && $in[$k] !== '') {
                $p = $in[$k];
                $path = str_starts_with($p, $this->projectDir . '/') ? substr($p, strlen($this->projectDir) + 1) : basename($p);
                break;
            }
        }
        $text = match ($name) {
            'Read' => 'Membaca ' . $path,
            'Write' => 'Menulis ' . $path,
            'Edit', 'MultiEdit', 'NotebookEdit' => 'Mengubah ' . $path,
            'Bash' => 'Menjalankan: ' . ($str($in['description'] ?? null) !== '' ? $str($in['description']) : self::firstToken($str($in['command'] ?? null)) . ' …'),
            'Grep' => "Mencari '" . KUtil::clip($str($in['pattern'] ?? null), 50) . "'",
            'Glob' => 'Mencari file ' . KUtil::clip($str($in['pattern'] ?? null), 60),
            'Agent', 'Task' => 'Mendelegasikan: ' . ($str($in['description'] ?? null) !== '' ? $str($in['description']) : 'subagent'),
            'SendMessage' => 'Mengirim pesan ke agent',
            'AskUserQuestion' => 'Bertanya ke user',
            'WebFetch', 'WebSearch' => 'Riset web',
            'Skill' => 'Memuat skill ' . $str($in['skill'] ?? null),
            'TodoWrite' => 'Memperbarui daftar tugas',
            'TaskCreate' => 'Membuat tugas: ' . $str($in['subject'] ?? null),
            'TaskUpdate' => 'Memperbarui tugas' . ($str($in['status'] ?? null) !== '' ? ' → ' . $str($in['status']) : ''),
            'TaskStop' => 'Menghentikan subagent',
            'SubagentHandback' => 'Menyerahkan laporan',
            'ToolSearch' => 'Mencari alat',
            default => KUtil::clip($name, 60),
        };
        return [KUtil::oneLine($text, 160), $path];
    }

    private static function firstToken(string $cmd): string
    {
        foreach (preg_split('/[ \n]+/', $cmd) ?: [] as $tok) {
            if ($tok !== '') {
                return $tok;
            }
        }
        return '';
    }
}
