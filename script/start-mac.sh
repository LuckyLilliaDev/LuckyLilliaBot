#!/bin/sh
chmod u+x ./LuckyLillia
xattr -cr ./LuckyLillia 2>/dev/null || true
if [ -e ./bin/llbot/node ]; then
  chmod u+x ./bin/llbot/node
  xattr -cr ./bin/llbot/node 2>/dev/null || true
fi
exec ./LuckyLillia "$@"
