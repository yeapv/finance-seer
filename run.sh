#!/usr/bin/env bash
# FinancialSeer scheduled-run wrapper: loads repo .env, runs one script, logs heartbeat.
# usage: run.sh scripts/<name>.py [args...]
set -a; source "$(dirname "$0")/.env"; set +a
# Deliver as the Hermes bot (this chat), not the legacy lobster_eng_bot.
if [ -f /opt/data/.env ]; then
  HTOK=$(grep -oP '^TELEGRAM_BOT_TOKEN=\K\S+' /opt/data/.env | head -1)
  [ -n "$HTOK" ] && export TELEGRAM_BOT_TOKEN="$HTOK"
fi
cd "$(dirname "$0")" || exit 1
SCRIPT="$1"; shift
mkdir -p logs
STAMP="$(date -u +%FT%TZ)"
echo "[$STAMP] $SCRIPT $*" >> logs/runs.log
set +e
set -o pipefail
.venv/bin/python "$SCRIPT" "$@" 2>&1 | tee -a logs/runs.log >/dev/null
RC=$?
echo "[$STAMP] $SCRIPT exit=$RC" >> logs/runs.log
# heartbeat record for watchdog
.venv/bin/python - "$SCRIPT" "$RC" <<'PY'
import json, sys, datetime, pathlib
name, rc = sys.argv[1], int(sys.argv[2])
p = pathlib.Path('data/run_heartbeats.json')
hb = json.loads(p.read_text()) if p.exists() else {}
hb[name.rsplit('/',1)[-1]] = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exit': rc}
p.parent.mkdir(exist_ok=True); p.write_text(json.dumps(hb, indent=1))
PY
exit $RC
