# My Vocal Studio (개인용 Suno 보컬 보정 · 학습 · 다중 보이스 변환 앱)

혼자 사용하기 위해 **Modal 서버리스 GPU + 스마트폰 홈 화면 설치형 앱(PWA)**을 하나로 묶은 완성 패키지입니다.
대기 중에는 GPU가 완전히 꺼지므로(Scale-to-zero) 사용하지 않을 때는 서버 비용이 발생하지 않습니다.

## 포함된 기능
1. **보정 · 변환**: Suno 보컬 WAV → 화음/리버브 분리(BS-RoFormer) → 클리핑 복원(PCHIP+A-SPADE) → 쉬머·공진 억제 → 선택 모델 가창 변환(Applio/RMVPE) → Apollo 고역 복원 → 4x 트루피크 리미터 → 원본/정제본/최종본 실시간 A/B 비교 및 24-bit WAV 저장
2. **보정 단독**: 음색 변환 없이 Suno 보컬의 깨짐·쉬머·잔향·치찰음만 정제하고 라우드니스 정규화
3. **학습 · 모델 관리**:
   - 새 목소리 모델 원스톱 학습 (사전 클리핑·디리버브 정제 포함)
   - 기존 `.pth` / `.index` 모델 앱 화면에서 바로 업로드
   - 등록된 모델 조회 및 삭제

## PC 없이 배포하는 방법 (GitHub Codespaces 기준)
1. GitHub에 새 비공개(Private) 저장소를 만들고 이 압축 파일의 모든 파일을 업로드합니다.
2. 저장소 우측 상단 `Code` → `Codespaces` → `Create codespace on main` 클릭.
3. 브라우저 하단 터미널에서 아래 한 줄 실행:
   ```bash
   bash deploy.sh
   ```
4. 안내에 따라 Modal 로그인 및 개인 PIN 번호를 입력하면 배포 완료 후 전용 HTTPS 주소(`https://...modal.run`)가 표시됩니다.

## 스마트폰에 앱으로 설치
- **Android (Chrome)**: 배포 주소 접속 → 우측 상단 `⋮` → **앱 설치** (또는 **홈 화면에 추가**)
- **iPhone / iPad (Safari)**: 배포 주소 접속 → 하단 공유 버튼 → **홈 화면에 추가**
