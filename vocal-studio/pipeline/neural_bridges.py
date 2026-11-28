from __future__ import annotations

from pathlib import Path


def remove_reverb(
    input_wav: str,
    work_dir: str,
    model_cache_dir: str = "/data/model_cache/audio_separator",
    dereverb_model: str = "dereverb_mel_band_roformer_anvuew_sdr_19.1729.ckpt",
) -> str:
    """nomadkaraoke/python-audio-separator의 Mel-Band RoFormer 잔향 제거 모델로 마른 보컬을 만든다.
    실패하면 원본을 그대로 돌려주지 않고 오류를 낸다."""
    from audio_separator.separator import Separator

    out_dir = Path(work_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    Path(model_cache_dir).mkdir(parents=True, exist_ok=True)

    sep = Separator(output_dir=str(out_dir), output_format="WAV", model_file_dir=model_cache_dir)
    sep.load_model(model_filename=dereverb_model)
    outputs = sep.separate(input_wav)

    def norm(p: str) -> str:
        return p.lower().replace(" ", "").replace("_", "").replace("-", "")

    dry = [p for p in outputs if "noreverb" in norm(p) or "(dry)" in p.lower()]
    if not dry:
        raise RuntimeError(f"잔향 제거 결과 파일을 찾지 못했습니다: {outputs}")
    cand = Path(dry[0])
    return str(cand if cand.is_absolute() else out_dir / cand.name)
