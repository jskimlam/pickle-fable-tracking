#!/usr/bin/env bash
# =====================================================================
# sync-engine.sh — 페이블 엔진 파일을 fable-ship-tracking 저장소에서 가져와 덮어쓴다
# 사용법: tools/sync-engine.sh [페이블 저장소 경로]   (기본: ../fable-ship-tracking)
# 엔진(직접 조회·항로·계산)의 원본은 페이블 저장소다. 이 저장소에서는 엔진 파일을 직접 고치지 말 것.
# 화면(index.html, js/pickle-ui.js)만 이 저장소에서 고친다.
# =====================================================================
set -euo pipefail
SRC="${1:-../fable-ship-tracking}/android/app/src/main/assets/www"   # 페이블 화면 자산 폴더
DST="$(cd "$(dirname "$0")/.." && pwd)/android/app/src/main/assets/www" # 이 저장소 화면 자산 폴더
if [ ! -d "$SRC/js" ]; then echo "페이블 저장소를 찾을 수 없습니다: $SRC" >&2; exit 1; fi
# 엔진 파일 목록 (화면 파일 ui.js·mapview.js 는 페이블 전용이라 가져오지 않는다)
for f in util route parsers bridge store engine brief; do cp "$SRC/js/$f.js" "$DST/js/$f.js"; done
cp "$SRC"/js/data/*.js "$DST/js/data/"
cp -r "$SRC/vendor/leaflet" "$DST/vendor/"
echo "엔진 동기화 완료: $(cd "$SRC/../../../../../.." && git rev-parse --short HEAD 2>/dev/null || echo '버전 확인 불가')"
