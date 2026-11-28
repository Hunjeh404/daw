# vocal-studio (DAW 4 Hoon-jay용 보컬 서버)

DAW가 부르는 Modal 서버리스 GPU 서버입니다. 화면은 없고 DAW 믹싱 탭에서 씁니다.
쓰지 않을 때는 GPU가 꺼져 있어(Scale-to-zero) 돌린 시간만큼만 크레딧이 듭니다.

## 하는 일
1. 잔향 제거: 보컬 트랙에서 리버브를 걷어냅니다 (Mel-Band RoFormer, audio-separator).
2. 목소리 변환: 등록한 목소리 모델(.pth/.index)로 보컬을 바꿉니다 (Applio/RVC, RMVPE).
3. 모델 관리: 모델 올리기·목록·지우기. 학습은 노트북의 Applio에서 하고 결과물만 올립니다.

## API (헤더 X-App-Pin 필요)
- POST /api/dereverb (file) → { job_id }
- POST /api/convert (file, model_name, pitch_shift, index_rate, protect) → { job_id }
- GET /api/jobs/{job_id} → { status: queued|running|done|failed, progress, message }
- GET /api/jobs/{job_id}/audio → 결과 WAV
- GET /api/models, POST /api/models/upload (model_name, pth_file, index_file), DELETE /api/models/{name}

DAW 주소(https://hunjeh404.github.io)에서만 호출을 받습니다. 주소가 바뀌면 modal_app.py의 DAW_ORIGINS를 고칩니다.

## 배포 (GitHub Codespaces 또는 PC 터미널)
```bash
cd vocal-studio
bash deploy.sh
```
안내에 따라 Modal 로그인과 PIN을 설정하면 끝에 https://...modal.run 주소가 나옵니다. 그 주소와 PIN을 DAW 믹싱 탭의 목소리 서버 칸에 넣습니다.
