#!/usr/bin/env bash
set -euo pipefail

if [ -f /root/website-scout-web/.env ]; then
  cp /root/website-scout-web/.env /tmp/website-scout-web.env.bak
fi

rm -rf /root/website-scout-web

export GIT_SSH_COMMAND='ssh -i /root/.ssh/website_scout_web_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new'
git clone git@github.com:briktapinc/website-scout-web.git /root/website-scout-web

git -C /root/website-scout-web config core.sshCommand 'ssh -i /root/.ssh/website_scout_web_deploy -o IdentitiesOnly=yes'

if [ -f /tmp/website-scout-web.env.bak ]; then
  cp /tmp/website-scout-web.env.bak /root/website-scout-web/.env
fi

cd /root/website-scout-web
git remote -v
git log -1 --oneline
ls -la
echo "LINKED_OK"
