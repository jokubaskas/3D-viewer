#!/bin/bash
# Atea 3D Matuoklis – transliacijų persiuntėjo diegimas VPS (Ubuntu 22.04 / 24.04, root).
# Paleidžia deploy\relay-setup.bat per SSH; prieš šį failą jis perduoda RELAY_KEY, RELAY_PUBLIC_IP ir
# MediaMTX konfigūraciją (deploy/relay/mediamtx.yml, /tmp/atea-relay.yml). Galima paleisti pakartotinai – atnaujina.
set -euo pipefail
: "${RELAY_KEY:?Nenurodytas RELAY_KEY}"
[ -f /tmp/atea-relay.yml ] || { echo "Nėra /tmp/atea-relay.yml"; exit 1; }
VER=v1.21.2

echo "== Atea persiuntėjas: diegiama MediaMTX $VER"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ufw openssl ca-certificates >/dev/null

IP="${RELAY_PUBLIC_IP:-}"
[ -n "$IP" ] || IP=$(curl -fs4 --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')

case "$(dpkg --print-architecture)" in
  amd64) A=amd64 ;;
  arm64) A=arm64 ;;
  *) echo "Nepalaikoma architektūra"; exit 1 ;;
esac

id mediamtx >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin mediamtx
mkdir -p /opt/mediamtx /etc/mediamtx
curl -fsSL "https://github.com/bluenviron/mediamtx/releases/download/${VER}/mediamtx_${VER}_linux_${A}.tar.gz" | tar xz -C /opt/mediamtx mediamtx

# Sertifikatas šifravimui (RTSPS iš jūsų kompiuterio ir WebRTC ryšio nustatymas). Savo pasirašytas – jį naudoja tik
# jūsų serveris (nginx, ffmpeg), naršyklės jo nemato.
if [ ! -f /etc/mediamtx/server.key ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout /etc/mediamtx/server.key -out /etc/mediamtx/server.crt \
    -days 3650 -subj "/CN=atea-relay" 2>/dev/null
fi

# Konfigūracija: viešas IP ir raktas (raktas – tik raidės ir skaičiai)
case "$RELAY_KEY" in *[!A-Za-z0-9]*) echo "Raktas gali būti tik iš raidžių ir skaičių"; exit 1 ;; esac
sed -e "s/RELAY_PUBLIC_IP/${IP}/" -e "s/RELAY_KEY_VALUE/${RELAY_KEY}/" /tmp/atea-relay.yml > /etc/mediamtx/mediamtx.yml
rm -f /tmp/atea-relay.yml
chown -R root:mediamtx /etc/mediamtx
chmod 750 /etc/mediamtx
chmod 640 /etc/mediamtx/*

cat > /etc/systemd/system/mediamtx.service <<'UNIT'
[Unit]
Description=Atea 3D Matuoklis - transliaciju persiuntejas (MediaMTX)
After=network-online.target
Wants=network-online.target

[Service]
User=mediamtx
Group=mediamtx
ExecStart=/opt/mediamtx/mediamtx /etc/mediamtx/mediamtx.yml
WorkingDirectory=/opt/mediamtx
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadOnlyPaths=/etc/mediamtx

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now mediamtx >/dev/null 2>&1
systemctl restart mediamtx

# Ugniasienė: SSH, RTSPS (8322), WebRTC ryšio nustatymas (8889), WebRTC vaizdas (8189)
ufw allow OpenSSH >/dev/null
ufw allow 8322/tcp >/dev/null
ufw allow 8889/tcp >/dev/null
ufw allow 8189/udp >/dev/null
ufw allow 8189/tcp >/dev/null
ufw --force enable >/dev/null

sleep 2
if systemctl is-active --quiet mediamtx; then
  echo "== Paruošta: persiuntėjas veikia (IP ${IP})"
else
  echo "== KLAIDA: MediaMTX nepasileido. Žurnalas:"
  journalctl -u mediamtx -n 30 --no-pager
  exit 1
fi
