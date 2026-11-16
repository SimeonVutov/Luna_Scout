#!/usr/bin/env bash
# Sets up LunaScout on a fresh Ubuntu 24.04 server, or updates it. Safe to run again.
#
#   sudo ./deploy/setup.sh luna-scout.online you@example.org
#
# The first argument is the domain, the second the contact address sent to JPL Horizons by the
# monthly ephemeris check (the application itself computes positions locally). The address is
# kept in /etc/lunascout.env on this server and is not part of the repository.
set -euo pipefail

DOMAIN="${1:?Usage: sudo ./deploy/setup.sh <domain> <contact-email>}"
CONTACT="${2:?Usage: sudo ./deploy/setup.sh <domain> <contact-email>}"

REPO_URL="https://github.com/SimeonVutov/Luna_Scout.git"
APP_USER="lunascout"
BASE="/srv/lunascout"
APP="$BASE/app"
DATA="$BASE/DATA"
UV="/home/$APP_USER/.local/bin/uv"

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo." >&2
  exit 1
fi

as_app() { sudo -u "$APP_USER" -H env "PATH=/home/$APP_USER/.local/bin:$PATH" "$@"; }

echo "==> Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git gpg ca-certificates debian-keyring debian-archive-keyring apt-transport-https

if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Swap (a safety margin for the terrain's memory peaks)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q /swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

echo "==> User and folders"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
mkdir -p "$BASE" "$DATA"
chown "$APP_USER:$APP_USER" "$BASE" "$DATA"

echo "==> Code"
if [[ -d "$APP/.git" ]]; then
  as_app git -C "$APP" pull --ff-only
else
  as_app git clone "$REPO_URL" "$APP"
fi

echo "==> uv and Python packages"
[[ -x "$UV" ]] || as_app bash -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'
(cd "$APP/backend" && as_app "$UV" sync --locked)

echo "==> NASA data (about 1.7 GB the first time; later runs skip what is there)"
(cd "$APP/backend" && as_app env "LUNASCOUT_DATA_DIR=$DATA" "$UV" run --locked lunascout-science fetch-data)

echo "==> Website"
(cd "$APP/frontend" && as_app npm ci && as_app npm run build)

echo "==> Settings"
cat > /etc/lunascout.env <<ENV
LUNASCOUT_DATA_DIR=$DATA
LUNASCOUT_HORIZONS_CONTACT=$CONTACT
LUNASCOUT_PUBLIC_MODE=1
ENV
chmod 640 /etc/lunascout.env
chown root:"$APP_USER" /etc/lunascout.env

echo "==> Services"
cp "$APP/deploy/lunascout-api.service" "$APP/deploy/lunascout-worker.service" \
  "$APP/deploy/lunascout-ephemeris-check.service" "$APP/deploy/lunascout-ephemeris-check.timer" \
  "$APP/deploy/lunascout-precompute.service" "$APP/deploy/lunascout-precompute.timer" /etc/systemd/system/
sed "s/DOMAIN/$DOMAIN/g" "$APP/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now lunascout-api lunascout-worker
systemctl restart lunascout-api lunascout-worker
systemctl enable --now lunascout-ephemeris-check.timer
systemctl enable --now lunascout-precompute.timer
# Queue the reference sites now too, rather than waiting for the first weekly run.
systemctl start lunascout-precompute
systemctl enable caddy
systemctl restart caddy

echo
echo "Done. Check https://$DOMAIN once the DNS record points at this server."
echo "Logs:  journalctl -u lunascout-api -f      journalctl -u lunascout-worker -f"
