from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf


def sanitize_model_name(name: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9_\-가-힣]", "_", name.strip())
    if not cleaned:
        raise ValueError("올바른 모델 이름을 입력해 주세요.")
    return cleaned[:48]


@dataclass
class VoiceModelInfo:
    name: str
    pth_path: Path
    index_path: Path | None
    sample_rate: int = 48000
    embedder_model: str = "contentvec"

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "has_index": self.index_path is not None,
            "sample_rate": self.sample_rate,
            "embedder_model": self.embedder_model,
        }


class MultiVoiceEngine:
    """다중 보이스 모델 레지스트리(조회/등록/삭제) + Applio(RVC) 학습·분할 추론 엔진."""

    def __init__(
        self,
        applio_dir: str = "/opt/external/Applio",
        models_dir: str = "/data/models",
        applio_python: str | None = None,
    ):
        self.applio_dir = Path(applio_dir).resolve()
        self.models_dir = Path(models_dir).resolve()
        self.models_dir.mkdir(parents=True, exist_ok=True)

        if applio_python:
            self.python_bin = applio_python
        else:
            venv_unix = self.applio_dir / ".venv" / "bin" / "python"
            venv_win = self.applio_dir / ".venv" / "Scripts" / "python.exe"
            if venv_unix.exists():
                self.python_bin = str(venv_unix)
            elif venv_win.exists():
                self.python_bin = str(venv_win)
            else:
                self.python_bin = sys.executable

    def list_models(self) -> dict[str, VoiceModelInfo]:
        registry: dict[str, VoiceModelInfo] = {}
        self.models_dir.mkdir(parents=True, exist_ok=True)
        for folder in sorted(self.models_dir.iterdir()):
            if not folder.is_dir():
                continue
            pths = sorted(folder.glob("*.pth"))
            if not pths:
                continue
            indices = sorted(folder.glob("*.index"))
            meta_file = folder / "meta.json"
            meta = json.loads(meta_file.read_text(encoding="utf-8")) if meta_file.exists() else {}

            registry[folder.name] = VoiceModelInfo(
                name=folder.name,
                pth_path=pths[0],
                index_path=indices[0] if indices else None,
                sample_rate=int(meta.get("sample_rate", 48000)),
                embedder_model=str(meta.get("embedder_model", "contentvec")),
            )
        return registry

    def register_uploaded_model(
        self,
        model_name: str,
        pth_bytes: bytes,
        index_bytes: bytes | None = None,
        sample_rate: int = 48000,
        embedder_model: str = "contentvec",
    ) -> VoiceModelInfo:
        safe_name = sanitize_model_name(model_name)
        target_dir = self.models_dir / safe_name
        target_dir.mkdir(parents=True, exist_ok=True)

        pth_path = target_dir / f"{safe_name}.pth"
        pth_path.write_bytes(pth_bytes)

        idx_path = None
        if index_bytes:
            idx_path = target_dir / f"{safe_name}.index"
            idx_path.write_bytes(index_bytes)

        meta = {
            "sample_rate": sample_rate,
            "embedder_model": embedder_model,
            "source": "uploaded",
        }
        (target_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        return VoiceModelInfo(safe_name, pth_path, idx_path, sample_rate, embedder_model)

    def delete_model(self, model_name: str) -> bool:
        target_dir = self.models_dir / model_name
        if target_dir.exists() and target_dir.is_dir():
            shutil.rmtree(target_dir)
            return True
        return False

    def _run_applio(self, args: list[str]) -> None:
        cmd = [self.python_bin, "core.py", *args]
        res = subprocess.run(cmd, cwd=str(self.applio_dir), capture_output=True, text=True)
        if res.returncode != 0:
            tail = (res.stderr or res.stdout or "")[-1200:]
            raise RuntimeError(f"Applio 실행 실패 ({args[0]}): {tail}")

    def train_voice_model(
        self,
        model_name: str,
        dataset_dir: str,
        sample_rate: int = 48000,
        total_epochs: int = 250,
        batch_size: int = 8,
        embedder_model: str = "contentvec",
        f0_method: str = "rmvpe",
        gpu_id: str = "0",
    ) -> VoiceModelInfo:
        safe_name = sanitize_model_name(model_name)
        cpu_cores = str(max(2, (os.cpu_count() or 4) - 1))
        dataset_abs = str(Path(dataset_dir).resolve())

        self._run_applio([
            "preprocess",
            "--model_name", safe_name,
            "--dataset_path", dataset_abs,
            "--sample_rate", str(sample_rate),
            "--cpu_cores", cpu_cores,
            "--cut_preprocess", "Automatic",
            "--chunk_len", "3.0",
            "--overlap_len", "0.3",
        ])

        self._run_applio([
            "extract",
            "--model_name", safe_name,
            "--f0_method", f0_method,
            "--sample_rate", str(sample_rate),
            "--cpu_cores", cpu_cores,
            "--gpu", gpu_id,
            "--embedder_model", embedder_model,
            "--include_mutes", "2",
        ])

        self._run_applio([
            "train",
            "--model_name", safe_name,
            "--save_every_epoch", "50",
            "--save_only_latest", "True",
            "--save_every_weights", "True",
            "--total_epoch", str(total_epochs),
            "--sample_rate", str(sample_rate),
            "--batch_size", str(batch_size),
            "--gpu", gpu_id,
            "--pretrained", "True",
        ])

        self._run_applio([
            "index",
            "--model_name", safe_name,
            "--index_algorithm", "Auto",
        ])

        log_dir = self.applio_dir / "logs" / safe_name
        target_dir = self.models_dir / safe_name
        target_dir.mkdir(parents=True, exist_ok=True)

        pth_candidates = sorted(
            [p for p in log_dir.glob("*.pth") if not p.name.startswith(("G_", "D_"))],
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        if not pth_candidates:
            pth_candidates = sorted(log_dir.glob("*.pth"), key=lambda p: p.stat().st_mtime, reverse=True)
        if not pth_candidates:
            raise FileNotFoundError(f"학습된 .pth 가중치를 찾을 수 없습니다: {log_dir}")

        idx_candidates = sorted(log_dir.glob("*.index"), key=lambda p: p.stat().st_mtime, reverse=True)

        dst_pth = target_dir / f"{safe_name}.pth"
        shutil.copy2(pth_candidates[0], dst_pth)
        dst_idx = None
        if idx_candidates:
            dst_idx = target_dir / f"{safe_name}.index"
            shutil.copy2(idx_candidates[0], dst_idx)

        meta = {
            "sample_rate": sample_rate,
            "embedder_model": embedder_model,
            "f0_method": f0_method,
            "total_epochs": total_epochs,
            "source": "trained",
        }
        (target_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        return VoiceModelInfo(safe_name, dst_pth, dst_idx, sample_rate, embedder_model)

    def convert_vocal_chunked(
        self,
        input_wav: str,
        output_wav: str,
        model_name: str,
        pitch_shift: int = 0,
        index_rate: float = 0.65,
        protect: float = 0.38,
        volume_envelope: float = 0.35,
        f0_method: str = "rmvpe",
        max_chunk_sec: float = 25.0,
        crossfade_ms: float = 80.0,
    ) -> str:
        """긴 보컬을 에너지 최소(호흡/무음) 구간으로 분할 추론 후 Equal-Power Crossfade 병합."""
        models = self.list_models()
        if model_name not in models:
            raise KeyError(f"등록되지 않은 모델: {model_name}")
        info = models[model_name]

        audio, sr = sf.read(input_wav, dtype="float32")
        if audio.ndim == 2:
            audio = audio.mean(axis=1)

        total_samples = len(audio)
        max_chunk_samples = int(max_chunk_sec * sr)
        fade_samples = int((crossfade_ms / 1000.0) * sr)

        split_points = [0]
        cursor = 0
        while cursor + max_chunk_samples < total_samples:
            search_start = cursor + int(max_chunk_samples * 0.7)
            search_end = min(cursor + max_chunk_samples, total_samples - fade_samples)
            window = audio[search_start:search_end]
            win_len = max(1, int(sr * 0.1))
            if len(window) > win_len:
                energy = np.convolve(window**2, np.ones(win_len), mode="valid")
                best_offset = int(np.argmin(energy)) + win_len // 2
                cut = search_start + best_offset
            else:
                cut = search_end
            split_points.append(cut)
            cursor = cut
        split_points.append(total_samples)

        converted_chunks: list[np.ndarray] = []
        out_sr = sr

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            for i in range(len(split_points) - 1):
                s = max(0, split_points[i] - (fade_samples if i > 0 else 0))
                e = min(total_samples, split_points[i + 1] + (fade_samples if i < len(split_points) - 2 else 0))
                chunk_in = tmp_path / f"in_{i}.wav"
                chunk_out = tmp_path / f"out_{i}.wav"
                sf.write(str(chunk_in), audio[s:e], sr, subtype="PCM_24")

                infer_args = [
                    "infer",
                    "--pitch", str(pitch_shift),
                    "--index_rate", str(index_rate),
                    "--volume_envelope", str(volume_envelope),
                    "--protect", str(protect),
                    "--f0_method", f0_method,
                    "--input_path", str(chunk_in),
                    "--output_path", str(chunk_out),
                    "--pth_path", str(info.pth_path),
                    "--embedder_model", info.embedder_model,
                    "--export_format", "WAV",
                    "--split_audio", "False",
                    "--clean_audio", "False",
                ]
                if info.index_path:
                    infer_args += ["--index_path", str(info.index_path)]

                self._run_applio(infer_args)
                c_audio, out_sr = sf.read(str(chunk_out), dtype="float32")
                if c_audio.ndim == 2:
                    c_audio = c_audio.mean(axis=1)
                converted_chunks.append(c_audio)

        fade_out_sr = int((crossfade_ms / 1000.0) * out_sr)
        merged = converted_chunks[0]
        for nxt in converted_chunks[1:]:
            ov = min(fade_out_sr * 2, len(merged), len(nxt))
            if ov > 0:
                t = np.linspace(0.0, np.pi / 2.0, ov, dtype=np.float32)
                blended = merged[-ov:] * np.cos(t) + nxt[:ov] * np.sin(t)
                merged = np.concatenate([merged[:-ov], blended, nxt[ov:]])
            else:
                merged = np.concatenate([merged, nxt])

        sf.write(output_wav, merged, out_sr, subtype="PCM_24")
        return output_wav
