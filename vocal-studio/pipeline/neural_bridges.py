from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


def separate_dry_lead_vocal(
    input_wav: str,
    work_dir: str,
    model_cache_dir: str = "/data/model_cache/audio_separator",
    dereverb_model: str = "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt",
    karaoke_model: str = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt",
    remove_harmony: bool = True,
    remove_reverb: bool = True,
) -> str:
    """
    nomadkaraoke/python-audio-separator 기반 전처리:
    1) 백킹 보컬/화음 제거 -> 리드 보컬 단일화 (RVC 음정 튐 방지)
    2) Mel-Band RoFormer 기반 De-Reverb -> 완전한 Dry 보컬 생성
    """
    if not remove_harmony and not remove_reverb:
        return input_wav

    out_dir = Path(work_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = Path(model_cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)

    try:
        from audio_separator.separator import Separator
    except ImportError:
        return input_wav

    current = input_wav

    if remove_harmony:
        try:
            sep_k = Separator(
                output_dir=str(out_dir),
                output_format="WAV",
                model_file_dir=str(cache_dir),
            )
            sep_k.load_model(model_filename=karaoke_model)
            outputs = sep_k.separate(current)
            lead_candidates = [p for p in outputs if "vocal" in p.lower() and "instr" not in p.lower()]
            if lead_candidates:
                cand = Path(lead_candidates[0])
                current = str(cand if cand.is_absolute() else (out_dir / cand.name))
        except Exception as e:
            print(f"[warn] karaoke separation skipped: {e}")

    if remove_reverb:
        try:
            sep_r = Separator(
                output_dir=str(out_dir),
                output_format="WAV",
                model_file_dir=str(cache_dir),
            )
            sep_r.load_model(model_filename=dereverb_model)
            outputs = sep_r.separate(current)
            dry_candidates = [
                p for p in outputs if ("noreverb" in p.lower() or "dry" in p.lower() or "no_reverb" in p.lower())
            ]
            if dry_candidates:
                cand = Path(dry_candidates[0])
                current = str(cand if cand.is_absolute() else (out_dir / cand.name))
        except Exception as e:
            print(f"[warn] dereverb separation skipped: {e}")

    return current


def ensure_apollo_checkpoint(cache_dir: str = "/data/model_cache/apollo") -> str | None:
    """Apollo 체크포인트가 영구 볼륨에 없으면 HuggingFace에서 자동 다운로드."""
    cdir = Path(cache_dir)
    cdir.mkdir(parents=True, exist_ok=True)
    existing = list(cdir.glob("*.bin")) + list(cdir.glob("*.ckpt")) + list(cdir.glob("*.pth"))
    if existing:
        return str(existing[0])

    try:
        from huggingface_hub import hf_hub_download

        ckpt = hf_hub_download(
            repo_id="JusperLee/Apollo",
            filename="pytorch_model.bin",
            local_dir=str(cdir),
        )
        return ckpt
    except Exception as e:
        print(f"[warn] Apollo checkpoint download skipped: {e}")
        return None


def run_apollo_vocal_restore(
    input_wav: str,
    output_wav: str,
    apollo_dir: str = "/opt/external/Apollo",
    ckpt_cache_dir: str = "/data/model_cache/apollo",
) -> str:
    """JusperLee/Apollo 기반 후처리 보컬 복원."""
    repo = Path(apollo_dir)
    infer_script = repo / "inference.py"
    if not infer_script.exists():
        shutil.copy2(input_wav, output_wav)
        return output_wav

    ckpt = ensure_apollo_checkpoint(ckpt_cache_dir)
    in_abs = str(Path(input_wav).resolve())
    out_abs = str(Path(output_wav).resolve())

    env = os.environ.copy()
    env["PYTHONPATH"] = str(repo) + os.pathsep + env.get("PYTHONPATH", "")

    attempts = []
    if ckpt:
        attempts.append([sys.executable, str(infer_script), "--in_wav", in_abs, "--out_wav", out_abs, "--ckpt", ckpt])
    attempts.append([sys.executable, str(infer_script), "--in_wav", in_abs, "--out_wav", out_abs])

    for cmd in attempts:
        res = subprocess.run(cmd, cwd=str(repo), env=env, capture_output=True, text=True)
        if res.returncode == 0 and Path(output_wav).exists():
            return output_wav

    shutil.copy2(input_wav, output_wav)
    return output_wav
