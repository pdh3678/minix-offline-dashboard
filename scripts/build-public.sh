#!/usr/bin/env bash
# 공개 배포 폴더(public/) 만들기 — Render Static Site의 Build Command.
#   Render 설정: Build Command = bash scripts/build-public.sh / Publish Directory = public
#
# 왜: Publish Directory가 저장소 루트(.)면 apps-script*.js·appsscript.json·tests/·render.yaml·.gitignore까지
#     공개 URL로 열린다. Render는 실제 파일이 있는 경로에는 rewrite 규칙을 적용하지 않아서 규칙으로는 막을 수 없다.
#     그래서 앱이 실제로 불러오는 파일만 public/에 복사하고 그 폴더만 배포한다(허용 목록 방식 — 새 파일은 기본 비공개).
#
# 새 공개 파일을 추가했다면 아래 PUBLIC_FILES / PUBLIC_DIRS에 넣을 것. 빠뜨리면 마지막 검사가
# "index.html이 참조하는데 public/에 없는 파일"로 빌드를 실패시킨다(배포 뒤에 404로 발견되는 일이 없게).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public"
cd "$ROOT"

# ── 공개 허용 목록 ──
PUBLIC_FILES=(
  index.html                      # 앱 본체
  dashboard.html                  # 옛 경로(/dashboard.html) 호환 사본 — index.html과 같은 파일
  form.html                       # 설문 응답 페이지(로그인 없음) — Render Rewrite /s/* → /form.html. JS·CSS는 src/features/survey/
  Minix_BI_White_Transparency.png # 사이드바 로고
  favicon.ico
  favicon-16.png
  favicon-32.png
  apple-touch-icon.png
)
PUBLIC_DIRS=(
  src            # 대시보드 본체 JS·CSS(index.html의 <script src>/<link href>)
  review-assets  # 회고 편집기 빌드 산출물(review.js·review.css) — 아래 빌드가 만든다
)
# public/ 안에 있으면 안 되는 이름(어느 깊이든) — 하나라도 있으면 빌드 실패
FORBIDDEN=(
  'apps-script*.js' appsscript.json render.yaml .gitignore .node-version CLAUDE.md
  tests samples scripts .git .claude review-app node_modules
)

# ── 1) 회고 편집기 빌드(기존 Build Command와 같다) ──
echo "[build-public] 회고 편집기 빌드"
(cd review-app && npm ci && npm run build)

# ── 2) public/ 을 비우고 허용 목록만 복사 ──
echo "[build-public] public/ 다시 만들기"
rm -rf "$OUT"
mkdir -p "$OUT"
for f in "${PUBLIC_FILES[@]}"; do
  [ -f "$f" ] || { echo "[build-public] 실패: 허용 목록의 파일이 없습니다 — $f" >&2; exit 1; }
  cp "$f" "$OUT/$f"
done
for d in "${PUBLIC_DIRS[@]}"; do
  [ -d "$d" ] || { echo "[build-public] 실패: 허용 목록의 폴더가 없습니다 — $d" >&2; exit 1; }
  cp -R "$d" "$OUT/$d"
done

# ── 3) 검사 ──
fail=0
# 3-a) 비공개여야 하는 파일·폴더가 섞이지 않았는지
for name in "${FORBIDDEN[@]}"; do
  found="$(find "$OUT" -name "$name" -print)"
  if [ -n "$found" ]; then echo "[build-public] 실패: 비공개 파일이 public/에 있습니다 — $found" >&2; fail=1; fi
done
# 3-b) HTML이 참조하는 로컬 파일이 전부 복사됐는지(외부 https·data:·# 링크는 제외)
for html in index.html dashboard.html form.html; do
  while IFS= read -r ref; do
    path="${ref%%[?#]*}"
    [ -z "$path" ] && continue
    if [ ! -e "$OUT/$path" ]; then echo "[build-public] 실패: $html 이 참조하는 $path 가 public/에 없습니다 — PUBLIC_FILES/PUBLIC_DIRS에 추가하세요" >&2; fail=1; fi
  done < <(grep -oE '(src|href)="[^"]+"' "$OUT/$html" | sed -E 's/^(src|href)="//; s/"$//' | grep -vE '^(https?:|//|data:|#|mailto:)' | sort -u)
done
# 3-c) 옛 주소 리다이렉트 스크립트가 그대로인지(HTML은 가공 없이 복사한다)
for html in index.html dashboard.html; do
  cmp -s "$html" "$OUT/$html" || { echo "[build-public] 실패: public/$html 이 원본과 다릅니다" >&2; fail=1; }
  grep -q "minix-gongu-dashboard.onrender.com" "$OUT/$html" || { echo "[build-public] 실패: public/$html 에 옛 주소 리다이렉트 스크립트가 없습니다" >&2; fail=1; }
done
# 3-d) form.html은 /s/{주소}로 서빙된다(Rewrite) — 상대경로는 /s/… 로 풀려 404가 되므로 로컬 자원은 전부 /로 시작해야 한다
while IFS= read -r ref; do
  case "$ref" in /*) ;; *) echo "[build-public] 실패: form.html 의 '$ref' 가 상대경로입니다 — /s/{주소}에서 열리므로 /로 시작하는 절대경로로 쓰세요" >&2; fail=1 ;; esac
done < <(grep -oE '(src|href)="[^"]+"' "$OUT/form.html" | sed -E 's/^(src|href)="//; s/"$//' | grep -vE '^(https?:|//|data:|#|mailto:)' | sort -u)
[ "$fail" = 0 ] || exit 1

echo "[build-public] 완료 — $(find "$OUT" -type f | wc -l | tr -d ' ')개 파일"
ls -la "$OUT" "$OUT/review-assets"
