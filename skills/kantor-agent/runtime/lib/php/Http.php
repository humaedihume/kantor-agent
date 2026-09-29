<?php
declare(strict_types=1);

/** Bagian HTTP bersama untuk server PHP (setara lib/node/http.mjs). */
final class KHttp
{
    public const SECURITY_HEADERS = [
        'X-Robots-Tag' => 'noindex, nofollow',
        'Referrer-Policy' => 'no-referrer',
        'X-Content-Type-Options' => 'nosniff',
        'X-Frame-Options' => 'DENY',
        'Content-Security-Policy' => "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    ];

    /** @param array<string,mixed> $cfg @return array<string,mixed> */
    public static function pageConfig(array $cfg): array
    {
        return ['title' => $cfg['title'], 'ketua' => $cfg['ketua'], 'team' => $cfg['team'], 'colors' => $cfg['colors'], 'spare_desks' => $cfg['spare_desks']];
    }

    /** Perlindungan DNS rebinding — lihat lib/node/http.mjs. */
    public static function hostAllowed(?string $hostHeader, string $extra): bool
    {
        if ($hostHeader === null || $hostHeader === '') {
            return true;
        }
        $h = strtolower($hostHeader);
        if (!preg_match('/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/', $h, $m)) {
            return false;
        }
        $name = $m[1];
        if ($name[0] === '[' || preg_match('/^\d{1,3}(\.\d{1,3}){3}$/', $name)) {
            return true;
        }
        if ($name === 'localhost' || str_ends_with($name, '.localhost') || str_ends_with($name, '.trycloudflare.com')) {
            return true;
        }
        foreach (explode(',', strtolower($extra)) as $x) {
            $e = trim($x);
            if ($e !== '' && ($name === $e || (str_starts_with($e, '.') && str_ends_with($name, $e)))) {
                return true;
            }
        }
        return false;
    }
}
