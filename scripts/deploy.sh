#!/usr/bin/env bash
# Deploy discord-ai-bot to the production GCE VM (git-based).
#
# Prereq (one-time): /opt/discord-bot on the VM is a git clone of this repo.
# .env and settings.json live in /opt/discord-bot but are untracked, so they
# survive every deploy.
#
# Usage:
#   scripts/deploy.sh              # deploy origin/main
#   scripts/deploy.sh origin/mybr  # deploy another ref (testing)
#   scripts/deploy.sh --rollback   # reset to the previous deploy tag
set -euo pipefail

VM=discord-bot
ZONE=us-central1-a
REF="${1:-origin/main}"

if [ "$REF" = "--rollback" ]; then
  gcloud compute ssh "$VM" --zone "$ZONE" --command '
    set -e
    cd /opt/discord-bot
    PREV=$(sudo git describe --tags --abbrev=0 deploy-prev 2>/dev/null || true)
    if [ -z "$PREV" ]; then echo "no deploy-prev tag found"; exit 1; fi
    sudo git reset --hard deploy-prev
    sudo npm ci --omit=dev 2>&1 | tail -1
    sudo pm2 restart discord-bot --update-env
    sleep 6
    sudo pm2 list | grep discord-bot
    echo "rolled back to $(sudo git rev-parse --short HEAD)"
  '
  exit 0
fi

gcloud compute ssh "$VM" --zone "$ZONE" --command "
  set -e
  cd /opt/discord-bot
  sudo git tag -f deploy-prev HEAD
  sudo git fetch origin
  sudo git reset --hard $REF
  sudo npm ci --omit=dev 2>&1 | tail -1
  sudo pm2 restart discord-bot --update-env
  sleep 6
  sudo pm2 list | grep discord-bot
  sudo tail -c 400 /root/.pm2/logs/discord-bot-error.log
  echo \"deployed \$(sudo git rev-parse --short HEAD)\"
"
