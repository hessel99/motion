#!/bin/sh
# Replaces the installed Motion.app with a downloaded, verified one after the app has quit.
# Started detached by electron/updates/shell-mac.cjs (copied to the app data folder first, since
# this file lives inside the bundle that gets replaced).
#   mac-swap.sh <pid> <installed .app> <new .app> <relaunch 0|1> <log file>
# The swap is two renames next to the installed app (same volume), so the app is never half there;
# if the second rename fails the old app is moved back.
set -u
PID="$1"; DEST="$2"; SRC="$3"; RELAUNCH="$4"; LOG="$5"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

case "$DEST" in *.app) ;; *) log "refusing to replace $DEST (not an .app)"; exit 1 ;; esac
[ -d "$SRC" ] || { log "new app missing: $SRC"; exit 1; }

# wait for the running app to exit (at most 2 minutes)
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 600 ]; then log "app $PID did not exit, update skipped"; exit 1; fi
  sleep 0.2
done

PARENT=$(dirname "$DEST"); NAME=$(basename "$DEST")
STAGE="$PARENT/.$NAME.update-$$"; OLD="$PARENT/.$NAME.old-$$"
rm -rf "$STAGE"
if command -v ditto >/dev/null 2>&1; then ditto "$SRC" "$STAGE"; else cp -R "$SRC" "$STAGE"; fi
if [ $? -ne 0 ] || [ ! -d "$STAGE" ]; then log "copy to $STAGE failed"; rm -rf "$STAGE"; exit 1; fi

# unsigned builds: drop the quarantine flag and give the bundle a fresh ad-hoc signature
if command -v xattr >/dev/null 2>&1; then xattr -cr "$STAGE" >>"$LOG" 2>&1 || log "xattr failed"; fi
if command -v codesign >/dev/null 2>&1; then codesign --force --deep -s - "$STAGE" >>"$LOG" 2>&1 || log "ad-hoc codesign failed"; fi

STATUS=0
if ! mv "$DEST" "$OLD"; then log "could not move the old app aside"; rm -rf "$STAGE"; exit 1; fi
if mv "$STAGE" "$DEST"; then
  rm -rf "$OLD" "$SRC"
  log "updated $DEST"
else
  mv "$OLD" "$DEST"
  rm -rf "$STAGE"
  log "swap failed, old app restored"
  STATUS=1
fi

if [ "$RELAUNCH" = "1" ] && command -v open >/dev/null 2>&1; then open "$DEST"; fi
exit "$STATUS"
