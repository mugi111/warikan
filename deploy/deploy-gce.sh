#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

config_file="${GCE_DEPLOY_CONFIG:-deploy/gce.env}"
if [[ -f "$config_file" ]]; then
  set -a
  source "$config_file"
  set +a
fi

required=(GCE_PROJECT_ID GCE_ZONE GCE_INSTANCE)
for key in "${required[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    printf 'Missing required setting: %s\n' "$key" >&2
    exit 2
  fi
done

if ! command -v gcloud >/dev/null 2>&1; then
  printf 'Google Cloud CLI (gcloud) is required.\n' >&2
  exit 2
fi
if ! command -v git >/dev/null 2>&1; then
  printf 'Git is required.\n' >&2
  exit 2
fi
if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  printf 'Commit or stash repository changes before deploying.\n' >&2
  exit 2
fi

if [[ ! "$GCE_INSTANCE" =~ ^[A-Za-z0-9._@-]+$ || ! "$GCE_PROJECT_ID" =~ ^[A-Za-z0-9:._-]+$ || ! "$GCE_ZONE" =~ ^[A-Za-z0-9-]+$ ]]; then
  printf 'GCE project, zone, or instance contains unsupported characters.\n' >&2
  exit 2
fi

ssh_flags=()
case "${GCE_SSH_MODE:-public}" in
  public) ;;
  iap) ssh_flags+=(--tunnel-through-iap) ;;
  internal) ssh_flags+=(--internal-ip) ;;
  *) printf 'GCE_SSH_MODE must be public, iap, or internal.\n' >&2; exit 2 ;;
esac

release_id="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=12 HEAD)"
temp_dir="$(mktemp -d)"
archive="$temp_dir/warikan-$release_id.tar.gz"
remote_archive="/tmp/warikan-$release_id.tar.gz"
remote_script="/tmp/warikan-update-$release_id.sh"
trap 'rm -rf "$temp_dir"' EXIT

git archive --format=tar.gz --prefix=warikan/ --output="$archive" HEAD
gcloud compute scp --project="$GCE_PROJECT_ID" --zone="$GCE_ZONE" "${ssh_flags[@]}" --compress \
  "$archive" "$GCE_INSTANCE:$remote_archive"
gcloud compute scp --project="$GCE_PROJECT_ID" --zone="$GCE_ZONE" "${ssh_flags[@]}" \
  deploy/remote-update.sh "$GCE_INSTANCE:$remote_script"
gcloud compute ssh "$GCE_INSTANCE" --project="$GCE_PROJECT_ID" --zone="$GCE_ZONE" "${ssh_flags[@]}" \
  --command="sudo /bin/bash '$remote_script' '$release_id' '$remote_archive'"

printf 'GCE deployment completed: %s\n' "$release_id"
