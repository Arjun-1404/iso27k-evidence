#!/usr/bin/env bash
# Checks this machine before you install the portal, and tells you what to do about anything that would get in the way.
# It only looks — it changes nothing, installs nothing, and sends nothing but a few small web requests (listed below).
#
#   bash scripts/preflight.sh
#
# Web requests it makes: a tiny request to registry.npmjs.org, registry.yarnpkg.com, registry.npmmirror.com (where the
# libraries are downloaded from) and registry-1.docker.io (where Docker images come from).
set -u
cd "$(dirname "$0")/.." || exit 1

FAIL=0; WARN=0
# The offline download carries the libraries (node_modules without the testing tools) and the built web app, so npm's
# download server is not needed to run it.
OFFLINE=0
{ [ -d node_modules/tsx ] && [ ! -d node_modules/vitest ] && [ -f frontend/dist/index.html ]; } && OFFLINE=1
ok()   { printf '  [ ok ] %s\n' "$*"; }
warn() { printf '  [warn] %s\n' "$*"; WARN=$((WARN+1)); }
bad()  { printf '  [FAIL] %s\n' "$*"; FAIL=$((FAIL+1)); }
note() { printf '         %s\n' "$*"; }
head_() { printf '\n%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

head_ "Programs"
if have node; then
  v=$(node -v 2>/dev/null); major=${v#v}; major=${major%%.*}
  case "$major" in
    22|24) ok "Node.js $v (22 and 24 are the tested versions)" ;;
    *)     warn "Node.js $v — only 22 and 24 were tested; newer or older may work, but if something odd happens, try 22 or 24" ;;
  esac
else
  bad "Node.js is not installed. Install version 22 or 24 (see the README, \"Manual setup\", step 1)."
fi

DOCKER_OK=0
if have docker; then
  dout=$(docker info 2>&1 >/dev/null); drc=$?
  if [ $drc -eq 0 ]; then
    DOCKER_OK=1; ok "Docker is installed and you may use it"
  elif printf '%s' "$dout" | grep -qi "permission denied"; then
    warn "Docker is installed but you are not allowed to use it yet."
    note "Log out and back in (after: sudo usermod -aG docker \$USER), or put sudo in front of every docker command."
  else
    warn "Docker is installed but not running: sudo systemctl enable --now docker"
  fi
  if docker compose version >/dev/null 2>&1; then
    ok "Docker Compose v2 ($(docker compose version --short 2>/dev/null))"
  else
    warn "Docker Compose v2 (the \"docker compose\" command) is missing — install the docker-compose-plugin package. Only needed for the Docker route."
  fi
else
  note "Docker is not installed — fine if you will use the no-Docker route."
fi

if have psql || have pg_lsclusters; then
  ok "PostgreSQL tools found ($(psql --version 2>/dev/null | head -1))"
  have pg_lsclusters && pg_lsclusters 2>/dev/null | sed 's/^/         /'
else
  note "PostgreSQL is not installed — fine for the Docker route; the no-Docker route needs it (README, \"Manual setup\", step 1)."
fi

head_ "This machine"
mem_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)
if [ -n "${mem_kb:-}" ]; then
  mem_mb=$((mem_kb/1024))
  if [ "$mem_mb" -ge 3500 ]; then ok "Memory: $mem_mb MB"; else warn "Memory: $mem_mb MB — building Docker images wants about 4 GB; give the virtual machine more if the build is killed."; fi
fi
disk_mb=$(df -Pm . 2>/dev/null | awk 'NR==2{print $4}')
if [ -n "${disk_mb:-}" ]; then
  if [ "$disk_mb" -ge 3000 ]; then ok "Free disk space here: $disk_mb MB"; else warn "Free disk space here: $disk_mb MB — Docker images and libraries need about 3 GB."; fi
fi
for p in 3000 5173; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    warn "Port $p is already in use. The portal needs it: stop the other program, or a previous copy of the portal (docker compose stop / Ctrl-C)."
  else
    ok "Port $p is free"
  fi
done

head_ "Network (the part that has caused the most trouble)"
[ "$OFFLINE" -eq 1 ] && ok "The libraries are already included in this download — no npm download is needed"
# probe <host> <path> <extra curl flag> -> prints "<http code>" on success or the curl error text
probe() {
  local out; out=$(curl ${3:-} -sS -m 8 -o /dev/null -w '%{http_code}' "https://$1$2" 2>&1 | tr '\n' ' ' | sed 's/ *$//')
  case "$out" in *000) out=${out%000}; out=${out% } ;; esac     # curl adds 000 after its own error text
  printf '%s' "${out:-no answer}"
}
good() { case "$1" in 200|301|302|401|404) return 0;; *) return 1;; esac; }

if ! have curl; then
  warn "curl is not installed (sudo apt install -y curl), so the network checks were skipped."
else
  N_DEF=$(probe registry.npmjs.org /vary "");   N_V4=$(probe registry.npmjs.org /vary -4)
  Y_DEF=$(probe registry.yarnpkg.com /vary ""); M_DEF=$(probe registry.npmmirror.com /vary "")
  H_DEF=$(probe registry-1.docker.io /v2/ "")

  BEST=""
  if good "$N_DEF"; then
    ok "registry.npmjs.org is reachable — libraries will download normally"
  else
    if good "$N_V4"; then
      warn "registry.npmjs.org works only over IPv4 here ($N_DEF over the default route) — IPv6 on this network is broken or intercepted."
      note "No-Docker route: run   export NODE_OPTIONS=--dns-result-order=ipv4first   in the terminal before npm ci."
      note "Docker route:    sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1 net.ipv6.conf.default.disable_ipv6=1 && sudo systemctl restart docker"
    else
      if [ "$OFFLINE" -eq 1 ]; then
        warn "registry.npmjs.org cannot be reached: $N_DEF — but you do not need it: this download already contains the libraries."
        note "No-Docker route: skip the npm ci step. Docker route: add this line to .env"
        note "  COMPOSE_FILE=docker-compose.yml:docker-compose.prebuilt-frontend.yml:docker-compose.offline.yml"
      else
        bad "registry.npmjs.org cannot be reached: $N_DEF"
      fi
      note "Something on this network blocks it or answers in its place (a filter, a captive portal, a proxy)."
      if good "$Y_DEF"; then BEST=https://registry.yarnpkg.com; elif good "$M_DEF"; then BEST=https://registry.npmmirror.com; fi
      if [ "$OFFLINE" -eq 1 ]; then
        :
      elif [ -n "$BEST" ]; then
        note "A mirror works, though. npm still checks every download against package-lock.json, so a mirror cannot change what is installed:"
        note "  Docker route:    add this line to .env   NPM_REGISTRY=$BEST"
        note "  No-Docker route: npm ci --omit=dev --registry=$BEST"
      else
        note "No mirror works either. Try another network (a phone hotspot) or a VPN for the one-time install of libraries."
      fi
    fi
  fi
  good "$Y_DEF" && ok "registry.yarnpkg.com (mirror) is reachable" || note "registry.yarnpkg.com (mirror): $Y_DEF"
  good "$M_DEF" && ok "registry.npmmirror.com (mirror) is reachable" || note "registry.npmmirror.com (mirror): $M_DEF"
  if good "$H_DEF"; then ok "Docker Hub is reachable (where Docker images come from)"; else warn "Docker Hub cannot be reached: $H_DEF — the Docker route needs it for the database and web server images."; fi

  # Does a container reach the internet too? Only tried when Docker works and the image is already here (no big download for a test).
  if [ "$DOCKER_OK" -eq 1 ]; then
    if docker image inspect node:22-slim >/dev/null 2>&1; then
      target="registry.npmjs.org"; [ -n "$BEST" ] && target=${BEST#https://}
      cout=$(timeout 30 docker run --rm node:22-slim node -e "fetch('https://$target/vary').then(r=>console.log('HTTP '+r.status)).catch(e=>console.log('FAILED '+(e.cause&&e.cause.code||e.message)))" 2>&1 | tail -1)
      case "$cout" in
        "HTTP 200") ok "A Docker container can reach $target too" ;;
        *) if [ "$OFFLINE" -eq 1 ]; then W=warn; else W=bad; fi
           $W "A Docker container cannot reach $target ($cout). The running portal's calls to Google Drive and your mail server would fail$([ "$OFFLINE" -eq 1 ] || printf ', and so would the build')."
           note "If the machine itself reached it above, the cause is Docker's own network: restart Docker, and see the README, \"If the build stops with ...\"." ;;
      esac
    else
      note "Container check skipped (the node:22-slim image is not downloaded yet; the first build will fetch it)."
    fi
  fi
fi

head_ "Result"
if [ $FAIL -gt 0 ]; then
  printf '  %d problem(s), %d warning(s). Fix the [FAIL] lines first — they will stop the install.\n' "$FAIL" "$WARN"
  exit 1
elif [ $WARN -gt 0 ]; then
  printf '  No blocking problems, %d warning(s). Read the [warn] lines that apply to the route you will use.\n' "$WARN"
else
  printf '  All good.\n'
fi
printf '  Next: README, "Quick start (Docker Compose)" or "Manual setup (no Docker)".\n'
