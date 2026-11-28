from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any

import modal
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

# DAW(GitHub Pages)에서 부르는 서버. 잔향 제거와 목소리 변환(RVC)만 한다.
DAW_ORIGINS = ["https://hunjeh404.github.io"]

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("ffmpeg", "git", "libsndfile1", "build-essential", "wget")
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
        "soundfile",
        "audio-separator[gpu]",
    )
    .run_commands(
        "mkdir -p /opt/external",
        "git clone --depth 1 https://github.com/IAHispano/Applio.git /opt/external/Applio",
        "pip install --no-cache-dir -r /opt/external/Applio/requirements.txt || true",
        "cd /opt/external/Applio && (python core.py prerequisites --pretraineds_hifigan True --models True --exe False || python rvc/lib/tools/prerequisites_download.py || true)",
    )
    .add_local_dir("pipeline", remote_path="/root/pipeline")
)

app = modal.App("my-personal-vocal-app", image=image)
vol = modal.Volume.from_name("my-vocal-storage", create_if_missing=True)
job_store = modal.Dict.from_name("my-vocal-jobs", create_if_missing=True)

MOUNT_DIR = Path("/data")
MODELS_DIR = MOUNT_DIR / "models"
JOBS_DIR = MOUNT_DIR / "jobs"
CACHE_DIR = MOUNT_DIR / "model_cache"

pin_secret = modal.Secret.from_name("my-vocal-pin", required_keys=["MY_VOCAL_PIN"])


def verify_pin(x_app_pin: str = Header(default="")):
    if x_app_pin != os.environ.get("MY_VOCAL_PIN", "123456"):
        raise HTTPException(status_code=401, detail="PIN 번호가 일치하지 않습니다.")


def _set_job(job_id: str, status: str, progress: int, message: str, extra: dict[str, Any] | None = None):
    data = {"job_id": job_id, "status": status, "progress": progress, "message": message}
    if extra:
        data.update(extra)
    job_store[job_id] = data


@app.function(gpu="L4", volumes={"/data": vol}, timeout=900)
def worker_dereverb(job_id: str, in_wav: str):
    import shutil

    from pipeline.neural_bridges import remove_reverb

    job_dir = JOBS_DIR / job_id
    try:
        vol.reload()
        _set_job(job_id, "running", 30, "잔향 제거 중")
        dry = remove_reverb(in_wav, work_dir=str(job_dir / "sep"), model_cache_dir=str(CACHE_DIR / "audio_separator"))
        shutil.copy2(dry, job_dir / "result.wav")
        vol.commit()
        _set_job(job_id, "done", 100, "잔향 제거 완료")
    except Exception as e:
        _set_job(job_id, "failed", 0, f"잔향 제거 오류: {e}")


@app.function(gpu="L4", volumes={"/data": vol}, timeout=1200)
def worker_convert(job_id: str, in_wav: str, model_name: str, pitch_shift: int, index_rate: float, protect: float):
    from pipeline.voice_engine import MultiVoiceEngine

    job_dir = JOBS_DIR / job_id
    try:
        vol.reload()
        _set_job(job_id, "running", 30, f"[{model_name}] 목소리로 바꾸는 중")
        engine = MultiVoiceEngine(applio_dir="/opt/external/Applio", models_dir=str(MODELS_DIR))
        engine.convert_vocal_chunked(
            input_wav=in_wav,
            output_wav=str(job_dir / "result.wav"),
            model_name=model_name,
            pitch_shift=pitch_shift,
            index_rate=index_rate,
            protect=protect,
        )
        vol.commit()
        _set_job(job_id, "done", 100, "목소리 변환 완료")
    except Exception as e:
        _set_job(job_id, "failed", 0, f"변환 오류: {e}")


web = FastAPI(title="My Vocal Studio")
web.add_middleware(
    CORSMiddleware,
    allow_origins=DAW_ORIGINS,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["X-App-Pin"],
)


def _engine():
    from pipeline.voice_engine import MultiVoiceEngine

    return MultiVoiceEngine(applio_dir="/opt/external/Applio", models_dir=str(MODELS_DIR))


async def _save_input(file: UploadFile) -> tuple[str, Path]:
    job_id = uuid.uuid4().hex[:10]
    job_dir = JOBS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    in_path = job_dir / "input.wav"
    in_path.write_bytes(await file.read())
    vol.commit()
    return job_id, in_path


@web.get("/api/models", dependencies=[Depends(verify_pin)])
def list_models():
    vol.reload()
    return {"models": [info.to_dict() for info in _engine().list_models().values()]}


@web.post("/api/models/upload", dependencies=[Depends(verify_pin)])
async def upload_model(
    model_name: str = Form(...),
    pth_file: UploadFile = File(...),
    index_file: UploadFile | None = File(default=None),
):
    vol.reload()
    pth_bytes = await pth_file.read()
    idx_bytes = await index_file.read() if (index_file and index_file.filename) else None
    info = _engine().register_uploaded_model(model_name=model_name, pth_bytes=pth_bytes, index_bytes=idx_bytes)
    vol.commit()
    return {"ok": True, "model": info.to_dict()}


@web.delete("/api/models/{model_name}", dependencies=[Depends(verify_pin)])
def delete_model(model_name: str):
    vol.reload()
    engine = _engine()
    if model_name not in engine.list_models() or not engine.delete_model(model_name):
        raise HTTPException(status_code=404, detail="모델을 찾을 수 없습니다.")
    vol.commit()
    return {"ok": True}


@web.post("/api/dereverb", dependencies=[Depends(verify_pin)])
async def start_dereverb(file: UploadFile = File(...)):
    job_id, in_path = await _save_input(file)
    _set_job(job_id, "queued", 5, "GPU 깨우는 중")
    worker_dereverb.spawn(job_id, str(in_path))
    return {"job_id": job_id}


@web.post("/api/convert", dependencies=[Depends(verify_pin)])
async def start_convert(
    file: UploadFile = File(...),
    model_name: str = Form(...),
    pitch_shift: int = Form(0),
    index_rate: float = Form(0.65),
    protect: float = Form(0.38),
):
    job_id, in_path = await _save_input(file)
    _set_job(job_id, "queued", 5, "GPU 깨우는 중")
    worker_convert.spawn(job_id, str(in_path), model_name, pitch_shift, index_rate, protect)
    return {"job_id": job_id}


@web.get("/api/jobs/{job_id}", dependencies=[Depends(verify_pin)])
def job_status(job_id: str):
    if job_id not in job_store:
        return JSONResponse({"status": "failed", "progress": 0, "message": "작업을 찾을 수 없습니다."}, status_code=404)
    return job_store[job_id]


@web.get("/api/jobs/{job_id}/audio", dependencies=[Depends(verify_pin)])
def get_audio(job_id: str):
    vol.reload()
    path = JOBS_DIR / job_id / "result.wav"
    if not path.exists():
        raise HTTPException(status_code=404, detail="결과 파일이 없습니다.")
    return FileResponse(str(path), media_type="audio/wav", filename=f"{job_id}.wav")


@app.function(volumes={"/data": vol}, secrets=[pin_secret])
@modal.asgi_app()
def fastapi_app():
    return web
