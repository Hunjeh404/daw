from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any

import modal
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git", "libsndfile1", "sox", "libsox-fmt-all", "build-essential", "wget")
    .pip_install(
        "torch==2.4.1",
        "torchaudio==2.4.1",
        "torchvision==0.19.1",
        extra_index_url="https://download.pytorch.org/whl/cu121",
    )
    .pip_install(
        "fastapi[standard]",
        "python-multipart",
        "numpy<2.0",
        "scipy",
        "soundfile",
        "pyloudnorm",
        "huggingface_hub",
        "omegaconf",
        "ml-collections",
        "einops",
        "audio-separator[gpu]",
    )
    .run_commands(
        "mkdir -p /opt/external",
        "git clone --depth 1 https://github.com/IAHispano/Applio.git /opt/external/Applio",
        "git clone --depth 1 https://github.com/JusperLee/Apollo.git /opt/external/Apollo",
        "pip install --no-cache-dir -r /opt/external/Applio/requirements.txt || true",
        "pip install --no-cache-dir git+https://github.com/TheApeMachine/deshimmer.git || true",
        "cd /opt/external/Applio && (python core.py prerequisites --pretraineds_hifigan True --models True --exe False || python rvc/lib/tools/prerequisites_download.py || true)",
    )
    .add_local_dir("pipeline", remote_path="/root/pipeline")
    .add_local_dir("static", remote_path="/root/static")
)

app = modal.App("my-personal-vocal-app", image=image)
vol = modal.Volume.from_name("my-vocal-storage", create_if_missing=True)
job_store = modal.Dict.from_name("my-vocal-jobs", create_if_missing=True)

MOUNT_DIR = Path("/data")
MODELS_DIR = MOUNT_DIR / "models"
JOBS_DIR = MOUNT_DIR / "jobs"
CACHE_DIR = MOUNT_DIR / "model_cache"

pin_secret = modal.Secret.from_name("my-vocal-pin", required_keys=["MY_VOCAL_PIN"])


def get_expected_pin() -> str:
    return os.environ.get("MY_VOCAL_PIN", "123456")


def verify_pin(x_app_pin: str = Header(default="")):
    if x_app_pin != get_expected_pin():
        raise HTTPException(status_code=401, detail="PIN 번호가 일치하지 않습니다.")


def _set_job(job_id: str, status: str, progress: int, message: str, extra: dict[str, Any] | None = None):
    data = {"job_id": job_id, "status": status, "progress": progress, "message": message}
    if extra:
        data.update(extra)
    job_store[job_id] = data


@app.function(gpu="L4", volumes={"/data": vol}, timeout=900)
def worker_restore_only(
    job_id: str,
    in_wav: str,
    remove_harmony: bool,
    remove_reverb: bool,
    shimmer_strength: float,
    deess_ratio: float,
    use_apollo: bool,
    target_lufs: float,
):
    import soundfile as sf
    from pipeline.audio_restorer import (
        declip_and_repair,
        load_wav_float32,
        suppress_suno_artifacts,
        true_peak_limiter_and_normalize,
        vocal_deesser_and_hpf,
    )
    from pipeline.neural_bridges import run_apollo_vocal_restore, separate_dry_lead_vocal

    job_dir = JOBS_DIR / job_id
    try:
        vol.reload()
        _set_job(job_id, "cleaning", 20, "1/4 화음·리버브 분리 중 (BS-RoFormer)")
        dry_path = separate_dry_lead_vocal(
            in_wav,
            work_dir=str(job_dir / "sep"),
            model_cache_dir=str(CACHE_DIR / "audio_separator"),
            remove_harmony=remove_harmony,
            remove_reverb=remove_reverb,
        )

        _set_job(job_id, "cleaning", 45, "2/4 클리핑(소리 깨짐) 복원 및 Suno 쉬머 억제 중")
        audio, sr = load_wav_float32(dry_path, target_sr=48000)
        audio = declip_and_repair(audio, sr)
        audio = suppress_suno_artifacts(audio, sr, shimmer_strength=shimmer_strength)
        audio = vocal_deesser_and_hpf(audio, sr, ratio=deess_ratio)
        mid_path = str(job_dir / "cleaned.wav")
        sf.write(mid_path, audio, sr, subtype="PCM_24")

        post_in = mid_path
        if use_apollo:
            _set_job(job_id, "mastering", 70, "3/4 Apollo 보컬 고역 질감 복원 중")
            post_in = run_apollo_vocal_restore(
                mid_path,
                str(job_dir / "apollo.wav"),
                apollo_dir="/opt/external/Apollo",
                ckpt_cache_dir=str(CACHE_DIR / "apollo"),
            )

        _set_job(job_id, "mastering", 90, "4/4 트루피크 리미터 및 라우드니스 정규화 중")
        final_audio, final_sr = load_wav_float32(post_in, target_sr=48000)
        final_audio = true_peak_limiter_and_normalize(
            final_audio, final_sr, target_lufs=target_lufs, ceiling_dbtp=-1.0
        )
        final_path = str(job_dir / "final.wav")
        sf.write(final_path, final_audio, final_sr, subtype="PCM_24")
        vol.commit()

        _set_job(job_id, "done", 100, "보정 완료! 원본과 보정본을 바로 비교해 보세요.")
    except Exception as e:
        _set_job(job_id, "failed", 0, f"보정 오류: {e}")


@app.function(gpu="L4", volumes={"/data": vol}, timeout=1200)
def worker_convert(
    job_id: str,
    in_wav: str,
    model_name: str,
    pitch_shift: int,
    remove_harmony: bool,
    shimmer_strength: float,
    index_rate: float,
    protect: float,
    use_apollo: bool,
):
    import soundfile as sf
    from pipeline.audio_restorer import (
        declip_and_repair,
        load_wav_float32,
        suppress_suno_artifacts,
        true_peak_limiter_and_normalize,
        vocal_deesser_and_hpf,
    )
    from pipeline.neural_bridges import run_apollo_vocal_restore, separate_dry_lead_vocal
    from pipeline.voice_engine import MultiVoiceEngine

    job_dir = JOBS_DIR / job_id
    try:
        vol.reload()
        _set_job(job_id, "cleaning", 15, "1/4 화음·리버브 분리 중 (BS-RoFormer)")
        dry_path = separate_dry_lead_vocal(
            in_wav,
            work_dir=str(job_dir / "sep"),
            model_cache_dir=str(CACHE_DIR / "audio_separator"),
            remove_harmony=remove_harmony,
            remove_reverb=True,
        )

        _set_job(job_id, "cleaning", 35, "2/4 클리핑 복원 및 Suno 쉬머 제거 중")
        audio, sr = load_wav_float32(dry_path, target_sr=48000)
        audio = declip_and_repair(audio, sr)
        audio = suppress_suno_artifacts(audio, sr, shimmer_strength=shimmer_strength)
        audio = vocal_deesser_and_hpf(audio, sr)
        cleaned_path = str(job_dir / "cleaned.wav")
        sf.write(cleaned_path, audio, sr, subtype="PCM_24")

        _set_job(job_id, "converting", 60, f"3/4 [{model_name}] 모델로 가창 변환 중 (RMVPE)")
        engine = MultiVoiceEngine(applio_dir="/opt/external/Applio", models_dir=str(MODELS_DIR))
        raw_path = str(job_dir / "raw_converted.wav")
        engine.convert_vocal_chunked(
            input_wav=cleaned_path,
            output_wav=raw_path,
            model_name=model_name,
            pitch_shift=pitch_shift,
            index_rate=index_rate,
            protect=protect,
        )

        _set_job(job_id, "mastering", 85, "4/4 보코더 고역 복원 및 트루피크 마스터링 중")
        post_in = raw_path
        if use_apollo:
            post_in = run_apollo_vocal_restore(
                raw_path,
                str(job_dir / "apollo.wav"),
                apollo_dir="/opt/external/Apollo",
                ckpt_cache_dir=str(CACHE_DIR / "apollo"),
            )

        final_audio, final_sr = load_wav_float32(post_in, target_sr=48000)
        final_audio = suppress_suno_artifacts(
            final_audio, final_sr, shimmer_strength=0.22, resonance_strength=0.35, use_external_deshimmer=False
        )
        final_audio = vocal_deesser_and_hpf(final_audio, final_sr, threshold_db=-20.0, ratio=2.5)
        final_audio = true_peak_limiter_and_normalize(final_audio, final_sr, target_lufs=-15.0, ceiling_dbtp=-1.0)

        final_path = str(job_dir / "final.wav")
        sf.write(final_path, final_audio, final_sr, subtype="PCM_24")
        vol.commit()

        _set_job(job_id, "done", 100, "변환 및 보정 완료! 원본·정제본·최종본을 비교해 보세요.")
    except Exception as e:
        _set_job(job_id, "failed", 0, f"변환 오류: {e}")


@app.function(gpu="A10G", volumes={"/data": vol}, timeout=3600)
def worker_train(job_id: str, model_name: str, dataset_dir: str, epochs: int, pre_dereverb: bool):
    import soundfile as sf
    from pipeline.audio_restorer import declip_and_repair, load_wav_float32, vocal_deesser_and_hpf
    from pipeline.neural_bridges import separate_dry_lead_vocal
    from pipeline.voice_engine import MultiVoiceEngine

    try:
        vol.reload()
        _set_job(job_id, "training", 10, "학습 데이터 클리핑·잔향 사전 정제 중")
        ds = Path(dataset_dir)
        for idx, wav in enumerate(sorted(ds.glob("*.wav"))):
            src = str(wav)
            if pre_dereverb:
                src = separate_dry_lead_vocal(
                    src,
                    work_dir=str(ds / f"_sep_{idx}"),
                    model_cache_dir=str(CACHE_DIR / "audio_separator"),
                    remove_harmony=False,
                    remove_reverb=True,
                )
            a, sr = load_wav_float32(src, target_sr=48000)
            a = vocal_deesser_and_hpf(declip_and_repair(a, sr), sr, hpf_hz=65.0)
            sf.write(str(wav), a, sr, subtype="PCM_24")

        _set_job(job_id, "training", 30, f"[{model_name}] 모델 학습 진행 중 ({epochs} epoch)")
        engine = MultiVoiceEngine(applio_dir="/opt/external/Applio", models_dir=str(MODELS_DIR))
        info = engine.train_voice_model(
            model_name=model_name,
            dataset_dir=dataset_dir,
            sample_rate=48000,
            total_epochs=epochs,
            batch_size=8,
            embedder_model="contentvec",
        )
        vol.commit()
        _set_job(job_id, "done", 100, f"[{info.name}] 학습 완료! 변환 탭에서 바로 선택할 수 있습니다.")
    except Exception as e:
        _set_job(job_id, "failed", 0, f"학습 실패: {e}")


web = FastAPI(title="My Vocal Studio")


@web.get("/")
def serve_app():
    return FileResponse("/root/static/index.html")


@web.get("/manifest.json")
def serve_manifest():
    return FileResponse("/root/static/manifest.json", media_type="application/manifest+json")


@web.get("/sw.js")
def serve_sw():
    return FileResponse("/root/static/sw.js", media_type="application/javascript")


@web.get("/api/models", dependencies=[Depends(verify_pin)])
def list_models():
    from pipeline.voice_engine import MultiVoiceEngine

    vol.reload()
    engine = MultiVoiceEngine(applio_dir="/opt/external/Applio", models_dir=str(MODELS_DIR))
    models = [info.to_dict() for info in engine.list_models().values()]
    return {"models": models}


@web.post("/api/models/upload", dependencies=[Depends(verify_pin)])
async def upload_existing_model(
    model_name: str = Form(...),
    pth_file: UploadFile = File(...),
    index_file: UploadFile | None = File(default=None),
    embedder_model: str = Form("contentvec"),
):
    from pipeline.voice_engine import MultiVoiceEngine

    vol.reload()
    engine = MultiVoiceEngine(applio_dir="/opt/external/Applio", models_dir=str(MODELS_DIR))
    pth_bytes = await pth_file.read()
    idx_bytes = await index_file.read() if (index_file and index_file.filename) else None
    info = engine.register_uploaded_model(
        model_name=model_name,
        pth_bytes=pth_bytes,
        index_bytes=idx_bytes,
        embedder_model=embedder_model,
    )
    vol.commit()
    return {"ok": True, "model": info.to_dict()}


@web.delete("/api/models/{model_name}", dependencies=[Depends(verify_pin)])
def delete_model(model_name: str):
    from pipeline.voice_engine import MultiVoiceEngine

    vol.reload()
    engine = MultiVoiceEngine(applio_dir="/opt/external/Applio", models_dir=str(MODELS_DIR))
    deleted = engine.delete_model(model_name)
    if not deleted:
        raise HTTPException(status_code=404, detail="모델을 찾을 수 없습니다.")
    vol.commit()
    return {"ok": True}


@web.post("/api/restore", dependencies=[Depends(verify_pin)])
async def start_restore(
    file: UploadFile = File(...),
    remove_harmony: bool = Form(True),
    remove_reverb: bool = Form(True),
    shimmer_strength: float = Form(0.55),
    deess_ratio: float = Form(3.0),
    use_apollo: bool = Form(True),
    target_lufs: float = Form(-15.0),
):
    job_id = uuid.uuid4().hex[:10]
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    in_path = job_dir / "input.wav"
    in_path.write_bytes(await file.read())
    vol.commit()

    _set_job(job_id, "queued", 5, "보정용 GPU 깨우는 중...")
    worker_restore_only.spawn(
        job_id, str(in_path), remove_harmony, remove_reverb, shimmer_strength, deess_ratio, use_apollo, target_lufs
    )
    return {"job_id": job_id}


@web.post("/api/convert", dependencies=[Depends(verify_pin)])
async def start_convert(
    file: UploadFile = File(...),
    model_name: str = Form(...),
    pitch_shift: int = Form(0),
    remove_harmony: bool = Form(True),
    shimmer_strength: float = Form(0.55),
    index_rate: float = Form(0.65),
    protect: float = Form(0.38),
    use_apollo: bool = Form(True),
):
    job_id = uuid.uuid4().hex[:10]
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    in_path = job_dir / "input.wav"
    in_path.write_bytes(await file.read())
    vol.commit()

    _set_job(job_id, "queued", 5, "변환용 GPU 깨우는 중...")
    worker_convert.spawn(
        job_id, str(in_path), model_name, pitch_shift, remove_harmony, shimmer_strength, index_rate, protect, use_apollo
    )
    return {"job_id": job_id}


@web.post("/api/train", dependencies=[Depends(verify_pin)])
async def start_train(
    model_name: str = Form(...),
    epochs: int = Form(250),
    pre_dereverb: bool = Form(True),
    files: list[UploadFile] = File(...),
):
    job_id = uuid.uuid4().hex[:10]
    ds_dir = JOBS_DIR / job_id / "dataset"
    ds_dir.mkdir(parents=True, exist_ok=True)
    for i, f in enumerate(files):
        (ds_dir / f"sample_{i:03d}.wav").write_bytes(await f.read())
    vol.commit()

    _set_job(job_id, "queued", 5, "학습용 A10G GPU 할당 중...")
    worker_train.spawn(job_id, model_name.strip(), str(ds_dir), epochs, pre_dereverb)
    return {"job_id": job_id}


@web.get("/api/jobs/{job_id}", dependencies=[Depends(verify_pin)])
def job_status(job_id: str):
    if job_id not in job_store:
        return JSONResponse({"status": "failed", "progress": 0, "message": "작업을 찾을 수 없습니다."}, status_code=404)
    return job_store[job_id]


@web.get("/api/jobs/{job_id}/audio/{kind}", dependencies=[Depends(verify_pin)])
def get_audio(job_id: str, kind: str):
    vol.reload()
    fname = "cleaned.wav" if kind == "cleaned" else "final.wav"
    path = JOBS_DIR / job_id / fname
    if not path.exists():
        raise HTTPException(status_code=404, detail="파일 없음")
    return FileResponse(str(path), media_type="audio/wav", filename=f"{job_id}_{fname}")


web.mount("/static", StaticFiles(directory="/root/static"), name="static")


@app.function(volumes={"/data": vol}, secrets=[pin_secret])
@modal.asgi_app()
def fastapi_app():
    return web
