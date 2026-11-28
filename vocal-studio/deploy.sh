#!/usr/bin/env bash
set -euo pipefail

echo "=== My Vocal Studio 배포 시작 ==="
pip install -q modal

if ! modal token info >/dev/null 2>&1; then
  echo "Modal 로그인을 진행합니다..."
  modal setup
fi

read -r -p "앱 접속용 개인 PIN 번호 입력 (예: 948210): " USER_PIN
USER_PIN="${USER_PIN:-123456}"

echo "개인 PIN을 Modal Secret으로 안전하게 저장합니다..."
modal secret create my-vocal-pin MY_VOCAL_PIN="$USER_PIN" --force

echo "GPU 컨테이너 빌드 및 앱 배포를 시작합니다 (최초 1회 약 5~8분 소요)..."
modal deploy modal_app.py

echo "=== 배포 완료! 출력된 modal.run 주소를 스마트폰 브라우저로 열고 '홈 화면에 추가'하세요. ==="
