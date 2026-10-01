#!/usr/bin/env bash
set -Eeuo pipefail

release_id="${1:-}"
archive="${2:-}"
if [[ ! "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$ || "$archive" != "/tmp/warikan-$release_id.tar.gz" ]]; then
  printf 'Invalid release arguments.\n' >&2
  exit 2
fi

deploy_root=/opt/warikan-deploy
release_dir="$deploy_root/releases/$release_id"
current_link="$deploy_root/current"
service_dir=/etc/systemd/system
config_file=/etc/warikan/warikan.env
rollback_dir="$(mktemp -d /tmp/warikan-rollback.XXXXXX)"
service_was_active=0
switched=0
systemd_changed=0
completed=0

save_unit() {
  local unit="$1"
  if [[ -f "$service_dir/$unit" ]]; then
    cp -a "$service_dir/$unit" "$rollback_dir/$unit"
    touch "$rollback_dir/$unit.exists"
  fi
}

restore_unit() {
  local unit="$1"
  if [[ -e "$rollback_dir/$unit.exists" ]]; then
    cp -a "$rollback_dir/$unit" "$service_dir/$unit"
  else
    rm -f "$service_dir/$unit"
  fi
}

rollback() {
  local result=$?
  trap - EXIT
  if [[ "$completed" -ne 1 ]]; then
    printf 'Deployment failed; restoring the previous service configuration.\n' >&2
    if [[ "$systemd_changed" -eq 1 ]]; then
      systemctl stop warikan.service >/dev/null 2>&1 || true
      if [[ "$switched" -eq 1 ]]; then
        if [[ -e "$rollback_dir/current.target" ]]; then
          ln -sfn "$(cat "$rollback_dir/current.target")" "$current_link.rollback"
          mv -Tf "$current_link.rollback" "$current_link"
        else
          rm -f "$current_link"
        fi
      fi
      restore_unit warikan.service
      restore_unit warikan-backup.service
      restore_unit warikan-backup.timer
      systemctl daemon-reload || true
      if [[ "$service_was_active" -eq 1 ]]; then
        systemctl restart warikan.service || printf 'Previous service could not be restarted.\n' >&2
      fi
    fi
    rm -f "$current_link.next" "$current_link.rollback"
    rm -rf "$release_dir"
  fi
  rm -rf "$rollback_dir" "$archive"
  exit "$result"
}
trap rollback EXIT

command -v node >/dev/null
command -v npm >/dev/null
command -v systemctl >/dev/null
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) process.exit(1)'
[[ -f "$config_file" ]] || { printf 'Missing Discord environment file: %s\n' "$config_file" >&2; exit 2; }
if systemctl is-active --quiet warikan.service; then service_was_active=1; fi

mkdir -p "$deploy_root/releases" /etc/sysusers.d /etc/warikan /var/lib/warikan
chmod 0700 /var/lib/warikan
mkdir "$release_dir"
tar -xzf "$archive" -C "$release_dir" --strip-components=1
rm -f "$archive"
install -m 0644 "$release_dir/deploy/sysusers.d/warikan.conf" /etc/sysusers.d/warikan.conf
systemd-sysusers /etc/sysusers.d/warikan.conf
cd "$release_dir"
npm ci
npm run build
npm prune --omit=dev
chown -R root:warikan "$release_dir"
find "$release_dir" -type d -exec chmod 0750 {} +
find "$release_dir" -type f -exec chmod 0640 {} +

if [[ -e /var/lib/warikan/warikan.sqlite ]]; then
  sudo -u warikan env DATABASE_PATH=/var/lib/warikan/warikan.sqlite \
    BACKUP_DIRECTORY=/var/lib/warikan/backups BACKUP_RETENTION_COUNT=7 BACKUP_TIMEOUT_SECONDS=240 \
    node "$release_dir/dist/operations/backup-command.js"
fi

save_unit warikan.service
save_unit warikan-backup.service
save_unit warikan-backup.timer
if [[ -L "$current_link" ]]; then readlink "$current_link" > "$rollback_dir/current.target"; fi

systemd_changed=1
install -m 0644 "$release_dir/deploy/systemd/warikan.service" "$service_dir/warikan.service"
install -m 0644 "$release_dir/deploy/systemd/warikan-backup.service" "$service_dir/warikan-backup.service"
install -m 0644 "$release_dir/deploy/systemd/warikan-backup.timer" "$service_dir/warikan-backup.timer"
systemctl daemon-reload
systemctl stop warikan.service || true
ln -s "$release_dir" "$current_link.next"
mv -Tf "$current_link.next" "$current_link"
switched=1
started_at="$(date --iso-8601=seconds)"
systemctl restart warikan.service

ready=0
for _ in $(seq 1 30); do
  if systemctl is-active --quiet warikan.service && journalctl -u warikan.service --since "$started_at" --no-pager -o cat 2>/dev/null | grep -Fq '"message":"Discord client ready"'; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" -ne 1 ]]; then
  journalctl -u warikan.service -n 50 --no-pager -o cat >&2 || true
  printf 'Bot did not reach Discord ready state.\n' >&2
  exit 1
fi

systemctl enable --now warikan-backup.timer
find "$deploy_root/releases" -mindepth 1 -maxdepth 1 -type d ! -name "$release_id" -printf '%T@ %p\n' \
  | sort -rn | tail -n +5 | cut -d' ' -f2- | xargs -r rm -rf
completed=1
printf 'Release %s is active.\n' "$release_id"
