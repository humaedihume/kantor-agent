<?php
declare(strict_types=1);

require_once __DIR__ . '/Util.php';

/**
 * Konfigurasi: defaults.json + penimpaan opsional <project>/.claude/kantor-agent.json (nama, judul).
 * Port Node: lib/node/config.mjs (harus identik — dicek bin/parity.mjs).
 */
final class KConfig
{
    public const REL = '.claude/kantor-agent.json';

    public static function cleanName(mixed $v, int $max = 20): ?string
    {
        if (!is_string($v)) {
            return null;
        }
        $s = trim((string) preg_replace('/[\x00-\x1f\x7f]+/', ' ', $v));
        if ($s === '') {
            return null;
        }
        return mb_substr($s, 0, $max);
    }

    /** @return array<string,mixed> */
    public static function defaults(string $runtimeDir): array
    {
        $d = json_decode((string) @file_get_contents($runtimeDir . '/defaults.json'), true);
        if (!is_array($d) || array_is_list($d)) {
            throw new RuntimeException('defaults.json tidak valid');
        }
        return $d;
    }

    /** @return array<string,mixed> */
    public static function load(string $runtimeDir, string $projectDir): array
    {
        $d = self::defaults($runtimeDir);
        $c = [];
        $f = $projectDir . '/' . self::REL;
        if (is_file($f)) {
            $j = json_decode((string) @file_get_contents($f), true);
            $c = is_array($j) && ($j === [] || !array_is_list($j)) ? $j : [];
        }
        $n = is_array($c['names'] ?? null) && !array_is_list($c['names']) ? $c['names'] : [];
        $team = self::values($n['team'] ?? null);
        $fl = [];
        foreach (self::values($n['freelancers'] ?? null) as $v) {
            $s = self::cleanName($v);
            if ($s !== null && !in_array($s, $fl, true)) {
                $fl[] = $s;
            }
        }
        $num = static fn($v, int $def): int => is_int($v) && $v > 0 ? $v : $def;
        return [
            'title' => self::cleanName($c['title'] ?? null, 60) ?? (self::cleanName(basename($projectDir), 60) ?? 'Project'),
            'ketua' => self::cleanName($n['ketua'] ?? null) ?? $d['ketua'],
            'team' => array_map(fn($def, $i) => self::cleanName($team[$i] ?? null) ?? $def, $d['team'], array_keys($d['team'])),
            'freelancers' => $fl ?: $d['freelancers'],
            'colors' => $d['colors'],
            'window_days' => $num($d['window_days'] ?? null, 7),
            'running_window' => $num($d['running_window'] ?? null, 900),
            'main_active' => $num($d['main_active'] ?? null, 90),
            'cooldown' => $num($d['cooldown'] ?? null, 60),
            'spare_desks' => $num($d['spare_desks'] ?? null, 4),
            'mains_max' => $num($d['mains_max'] ?? null, 40),
        ];
    }

    /** foreach JSON array/objek → daftar nilai */
    public static function values(mixed $v): array
    {
        return is_array($v) ? array_values($v) : [];
    }
}
