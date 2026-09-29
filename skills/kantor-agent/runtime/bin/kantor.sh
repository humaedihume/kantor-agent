#!/usr/bin/env bash
# Kantor Agent — server lokal untuk memantau agent Claude Code project di folder ini (read-only).
#
#   bash kantor.sh start   [--node|--php] [--port N] [--project DIR] [--bind ADDR]   jalankan (idempoten)
#   bash kantor.sh stop                                                              hentikan server + tunnel
#   bash kantor.sh restart [opsi start]
#   bash kantor.sh status                                                            status, URL, lokasi log
#   bash kantor.sh url                                                               cetak URL saja
#   bash kantor.sh tunnel                                                            URL publik sementara (cloudflared)
#   bash kantor.sh tunnel-stop
#   bash kantor.sh autostart                                                         untuk hook SessionStart (senyap, opt-in)
#   bash kantor.sh detect                                                            cek Node/PHP/cloudflared & transkrip
#
# Tidak menulis apa pun ke folder project. Cache, PID, dan log disimpan di
#   ${KANTOR_STATE_DIR:-${XDG_CACHE_HOME:-~/.cache}/kantor-agent}/<slug-project>/
# Variabel opsional: KANTOR_PORT, KANTOR_RUNTIME (node|php), KANTOR_BIND, KANTOR_STATE_DIR, KANTOR_AUTOSTART=1,
#   KANTOR_ALLOWED_HOSTS, CLAUDE_CONFIG_DIR. Penimpaan per project (opsional): <project>/.claude/kantor-agent.json
set -u

RUNTIME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CMD="${1:-start}"
[ $# -gt 0 ] && shift
WANT_RT="${KANTOR_RUNTIME:-}"
WANT_PORT=""
PROJ_ARG=""
BIND="${KANTOR_BIND:-127.0.0.1}"
QUIET=0
while [ $# -gt 0 ]; do
  case "$1" in
    --node) WANT_RT=node ;;
    --php) WANT_RT=php ;;
    --port) WANT_PORT="${2:-}"; shift ;;
    --port=*) WANT_PORT="${1#--port=}" ;;
    --project) PROJ_ARG="${2:-}"; shift ;;
    --project=*) PROJ_ARG="${1#--project=}" ;;
    --bind) BIND="${2:-}"; shift ;;
    --bind=*) BIND="${1#--bind=}" ;;
    --quiet|-q) QUIET=1 ;;
    -h|--help|help) CMD=help ;;
    *) echo "Opsi tidak dikenal: $1 (lihat: bash kantor.sh help)" >&2; exit 2 ;;
  esac
  shift
done

say() { [ "$QUIET" = 1 ] || printf '%s\n' "$*"; }
die() { printf 'Kantor Agent: %s\n' "$*" >&2; exit 1; }

if [ "$CMD" = help ]; then
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

# ---- project & folder status
if [ -n "$PROJ_ARG" ]; then P0="$PROJ_ARG"
elif [ -n "${KANTOR_PROJECT:-}" ]; then P0="$KANTOR_PROJECT"
elif [ "$CMD" = autostart ] && [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then P0="$CLAUDE_PROJECT_DIR"
else P0="$PWD"; fi
PROJECT="$(cd "$P0" 2>/dev/null && pwd -P)" || die "folder project tidak ditemukan: $P0"
SLUG="$(printf '%s' "$PROJECT" | sed 's/[^a-zA-Z0-9]/-/g')"
STATE="${KANTOR_STATE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/kantor-agent}/$SLUG"
ENVF="$STATE/server.env"
LOG="$STATE/server.log"
CONFIG="$PROJECT/.claude/kantor-agent.json"
TRANSCRIPTS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
TRANSCRIPTS="${TRANSCRIPTS%/}/projects/$SLUG"

cfg_value() { # nilai sederhana dari config JSON opsional (angka/boolean) tanpa bergantung pada runtime
  [ -f "$CONFIG" ] || return 0
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([0-9a-z]*\).*/\1/p" "$CONFIG" | head -1
}
envget() { [ -f "$ENVF" ] && sed -n "s/^$1=//p" "$ENVF" | head -1; }
alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
have_node() { command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' 2>/dev/null; }
have_php() { command -v php >/dev/null 2>&1 && php -r 'exit(PHP_VERSION_ID >= 80100 && function_exists("mb_strlen") ? 0 : 1);' 2>/dev/null; }
project_id() {
  if command -v md5sum >/dev/null 2>&1; then printf '%s' "$PROJECT" | md5sum | cut -c1-12
  elif command -v md5 >/dev/null 2>&1; then md5 -q -s "$PROJECT" | cut -c1-12
  elif have_node; then node -e 'process.stdout.write(require("crypto").createHash("md5").update(process.argv[1]).digest("hex").slice(0,12))' "$PROJECT"
  else php -r 'echo substr(md5($argv[1]), 0, 12);' "$PROJECT"; fi
}
http_get() {
  if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 3 "$1" 2>/dev/null; return $?; fi
  if have_node; then node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(3000)}).then(r=>r.ok?r.text():Promise.reject()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))' "$1"; return $?; fi
  php -r '$c = stream_context_create(["http" => ["timeout" => 3]]); $b = @file_get_contents($argv[1], false, $c); if ($b === false) exit(1); echo $b;' "$1"
}
ping_ok() { # server di port $1 adalah Kantor Agent untuk project ini
  local body
  body="$(http_get "http://$(host_for_url):$1/kerja/api/ping")" || return 1
  case "$body" in *'"app":"kantor-agent"'*'"project":"'"$PID_PROJECT"'"'*) return 0 ;; esac
  return 1
}
port_busy() { (exec 3<>"/dev/tcp/$(host_for_url)/$1") 2>/dev/null; }
host_for_url() { # alamat server yang tercatat (bila ada), selain itu alamat yang diminta sekarang
  local b
  b="$(envget BIND)"; b="${b:-$BIND}"
  case "$b" in 0.0.0.0|::|'') echo 127.0.0.1 ;; *) echo "$b" ;; esac
}
trim_log() { # log PHP bertambah tiap permintaan — potong bila > 5 MB (aman untuk berkas O_APPEND)
  local f
  for f in "$LOG" "$STATE/tunnel.log"; do
    [ -f "$f" ] && [ "$(wc -c <"$f" | tr -d ' ')" -gt 5242880 ] && : >"$f"
  done
  return 0
}
PID_PROJECT="$(project_id)"

running() { # 0 bila server tercatat & menjawab
  local pid port
  pid="$(envget PID)"; port="$(envget PORT)"
  alive "$pid" && [ -n "$port" ] && ping_ok "$port"
}

stop_tunnel() {
  local tp
  tp="$(cat "$STATE/tunnel.pid" 2>/dev/null || true)"
  if alive "$tp"; then
    case "$(ps -p "$tp" -o command= 2>/dev/null)" in
      *cloudflared*) # SIGTERM kedua = berhenti tanpa menunggu masa tenggang
        kill "$tp" 2>/dev/null; sleep 0.3; kill "$tp" 2>/dev/null
        local i=0; while alive "$tp" && [ $i -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
        alive "$tp" && kill -9 "$tp" 2>/dev/null ;;
    esac
  fi
  rm -f "$STATE/tunnel.pid" "$STATE/tunnel-url.txt"
}

stop_server() {
  local pid cmdline i
  pid="$(envget PID)"
  stop_tunnel
  if alive "$pid"; then
    cmdline="$(ps -p "$pid" -o command= 2>/dev/null || true)"
    case "$cmdline" in
      *serve-node.mjs*|*php*-S*)
        kill "$pid" 2>/dev/null
        i=0; while alive "$pid" && [ $i -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
        alive "$pid" && kill -9 "$pid" 2>/dev/null
        rm -f "$ENVF"
        return 0 ;;
    esac
  fi
  rm -f "$ENVF"
  return 1
}

print_running() {
  local port rt url
  port="$(envget PORT)"; rt="$(envget RUNTIME)"
  url="http://$(host_for_url):$port/kerja"
  say "Kantor Agent berjalan ($rt) untuk project: $(basename "$PROJECT")"
  say "  URL      : $url"
  case "$(envget BIND)" in 127.0.0.1|localhost|::1) ;; *) say "  Jaringan : juga terbuka di jaringan lokal (bind $(envget BIND)) — siapa pun di jaringan ini bisa membukanya" ;; esac
  [ -f "$STATE/tunnel-url.txt" ] && alive "$(cat "$STATE/tunnel.pid" 2>/dev/null)" && say "  Publik   : $(cat "$STATE/tunnel-url.txt")"
  say "  Hentikan : bash \"$RUNTIME/bin/kantor.sh\" stop"
  [ -d "$TRANSCRIPTS" ] || say "  Catatan  : belum ada transkrip Claude Code untuk folder ini — kantor terisi setelah Claude Code dipakai di sini."
}

start_server() {
  mkdir -p "$STATE/cache" || die "tidak bisa membuat $STATE"
  trim_log
  if running; then
    if [ "$(envget RUNTIME_DIR)" = "$RUNTIME" ] && { [ -z "$WANT_RT" ] || [ "$WANT_RT" = "$(envget RUNTIME)" ]; } \
      && { [ -z "$WANT_PORT" ] || [ "$WANT_PORT" = "$(envget PORT)" ]; }; then
      print_running
      return 0
    fi
    say "Memulai ulang (versi/runtime/port berubah)…"
    stop_server
  else
    stop_server >/dev/null 2>&1 || true
  fi
  local rt="$WANT_RT"
  if [ -z "$rt" ]; then
    if have_node; then rt=node; elif have_php; then rt=php; fi
  fi
  case "$rt" in
    node) have_node || die "Node ≥ 18 tidak ditemukan. Pasang Node 18+ (https://nodejs.org) atau pakai --php." ;;
    php) have_php || die "PHP ≥ 8.1 (+ mbstring) tidak ditemukan. Pasang PHP 8.1+ atau pakai --node." ;;
    *) die "Butuh Node ≥ 18 (disarankan) atau PHP ≥ 8.1. Pasang salah satu: https://nodejs.org · https://www.php.net" ;;
  esac
  local base="${WANT_PORT:-${KANTOR_PORT:-$(cfg_value port)}}"
  base="${base:-8788}"
  case "$base" in ''|*[!0-9]*) die "port tidak valid: $base" ;; esac
  [ "$base" -ge 1024 ] && [ "$base" -le 65535 ] || die "port harus 1024–65535: $base"
  local port=$base last=$((base + 20)) pid ok i
  while [ "$port" -le "$last" ]; do
    if port_busy "$port"; then port=$((port + 1)); continue; fi
    printf '\n[%s] start %s port %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$rt" "$port" >>"$LOG"
    if [ "$rt" = node ]; then
      KANTOR_PROJECT="$PROJECT" KANTOR_STORAGE="$STATE" KANTOR_PORT="$port" KANTOR_BIND="$BIND" \
        nohup node "$RUNTIME/bin/serve-node.mjs" </dev/null >>"$LOG" 2>&1 &
    else
      KANTOR_PROJECT="$PROJECT" KANTOR_STORAGE="$STATE" \
        nohup php -d display_errors=stderr -S "$BIND:$port" -t "$RUNTIME/public" "$RUNTIME/public/index.php" </dev/null >>"$LOG" 2>&1 &
    fi
    pid=$!
    ok=0; i=0
    while [ $i -lt 60 ]; do
      alive "$pid" || break
      if ping_ok "$port"; then ok=1; break; fi
      sleep 0.2; i=$((i + 1))
    done
    if [ $ok = 1 ]; then
      {
        echo "PID=$pid"; echo "PORT=$port"; echo "RUNTIME=$rt"; echo "BIND=$BIND"
        echo "RUNTIME_DIR=$RUNTIME"; echo "PROJECT=$PROJECT"; echo "STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      } >"$ENVF"
      [ "$port" != "$base" ] && say "Port $base sudah dipakai — memakai $port."
      print_running
      return 0
    fi
    if alive "$pid"; then kill "$pid" 2>/dev/null; fi
    if tail -n 5 "$LOG" | grep -qiE 'in use|sudah dipakai|Failed to listen|EADDRINUSE'; then port=$((port + 1)); continue; fi
    printf 'Kantor Agent: server gagal dijalankan. Log (%s):\n' "$LOG" >&2
    tail -n 15 "$LOG" >&2
    exit 1
  done
  die "tidak ada port bebas di $base–$last (pakai --port N)."
}

case "$CMD" in
  start) start_server ;;
  stop)
    if stop_server; then say "Kantor Agent dihentikan."; else say "Kantor Agent tidak sedang berjalan untuk project ini."; fi ;;
  restart) stop_server >/dev/null 2>&1 || true; start_server ;;
  url)
    if running; then echo "http://$(host_for_url):$(envget PORT)/kerja"; else exit 1; fi ;;
  status)
    trim_log
    if running; then print_running; say "  PID      : $(envget PID) · mulai $(envget STARTED)"
    else say "Kantor Agent tidak berjalan untuk project: $(basename "$PROJECT")"; say "  Mulai    : bash \"$RUNTIME/bin/kantor.sh\" start"; fi
    say "  Data     : $STATE"
    if [ -d "$TRANSCRIPTS" ]; then
      say "  Transkrip: $(find "$TRANSCRIPTS" -maxdepth 1 -name '*.jsonl' 2>/dev/null | wc -l | tr -d ' ') sesi utama, $(find "$TRANSCRIPTS" -path '*/subagents/*' -name 'agent-*.jsonl' 2>/dev/null | wc -l | tr -d ' ') subagent"
    else say "  Transkrip: belum ada ($TRANSCRIPTS)"; fi ;;
  tunnel)
    command -v cloudflared >/dev/null 2>&1 || die "cloudflared belum terpasang (macOS: brew install cloudflared · Linux: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)."
    running || QUIET=1 start_server
    running || die "server tidak berjalan."
    if alive "$(cat "$STATE/tunnel.pid" 2>/dev/null)" && [ -s "$STATE/tunnel-url.txt" ]; then
      say "Tunnel sudah aktif: $(cat "$STATE/tunnel-url.txt")"; exit 0
    fi
    : >"$STATE/tunnel.log"
    nohup cloudflared tunnel --no-autoupdate --grace-period 2s --url "http://$(host_for_url):$(envget PORT)" </dev/null >>"$STATE/tunnel.log" 2>&1 &
    echo $! >"$STATE/tunnel.pid"
    i=0; URL=""
    while [ $i -lt 40 ]; do
      URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$STATE/tunnel.log" | head -1 || true)"
      if [ -n "$URL" ] && grep -q 'Registered tunnel connection' "$STATE/tunnel.log"; then break; fi
      alive "$(cat "$STATE/tunnel.pid")" || break
      sleep 0.5; i=$((i + 1))
    done
    if [ -z "$URL" ] || ! grep -q 'Registered tunnel connection' "$STATE/tunnel.log"; then
      stop_tunnel; tail -n 10 "$STATE/tunnel.log" >&2; die "tunnel belum siap — lihat log di atas."
    fi
    echo "$URL/kerja" >"$STATE/tunnel-url.txt"
    say "URL publik: $URL/kerja"
    say "(alamat baru butuh ±30 detik sebelum bisa dibuka — bila gagal, tunggu sebentar lalu muat ulang)"
    say "PERINGATAN: siapa pun yang tahu link ini bisa melihat aktivitas agent project ini (read-only, diredaksi)."
    say "Bagikan hanya ke orang yang kamu percaya. Matikan: bash \"$RUNTIME/bin/kantor.sh\" tunnel-stop" ;;
  tunnel-stop) stop_tunnel; say "Tunnel dimatikan." ;;
  autostart)
    # Hook SessionStart: senyap, cepat, tidak pernah gagal. Aktif hanya bila KANTOR_AUTOSTART=1
    # atau "autostart": true di <project>/.claude/kantor-agent.json.
    if [ "${KANTOR_AUTOSTART:-}" = 1 ] || [ "$(cfg_value autostart)" = true ]; then
      ( bash "$RUNTIME/bin/kantor.sh" start --quiet --project "$PROJECT" >/dev/null 2>&1 & ) >/dev/null 2>&1
    fi
    exit 0 ;;
  detect)
    echo "Kantor Agent — deteksi lingkungan"
    if have_node; then echo "  node        $(node -v) (cukup)"; elif command -v node >/dev/null 2>&1; then echo "  node        $(node -v) (TERLALU LAMA, butuh ≥ 18)"; else echo "  node        tidak ada"; fi
    if have_php; then echo "  php         $(php -r 'echo PHP_VERSION;') (cukup)"; elif command -v php >/dev/null 2>&1; then echo "  php         $(php -r 'echo PHP_VERSION;') (butuh ≥ 8.1 + mbstring)"; else echo "  php         tidak ada"; fi
    command -v cloudflared >/dev/null 2>&1 && echo "  cloudflared ada (opsional, URL publik)" || echo "  cloudflared tidak ada (opsional)"
    command -v curl >/dev/null 2>&1 && echo "  curl        ada" || echo "  curl        tidak ada (dipakai Node/PHP sebagai gantinya)"
    echo "  project     $PROJECT"
    [ -d "$TRANSCRIPTS" ] && echo "  transkrip   ada ($TRANSCRIPTS)" || echo "  transkrip   belum ada ($TRANSCRIPTS)"
    echo "  data server $STATE" ;;
  *) echo "Perintah tidak dikenal: $CMD (start|stop|restart|status|url|tunnel|tunnel-stop|autostart|detect)" >&2; exit 2 ;;
esac
