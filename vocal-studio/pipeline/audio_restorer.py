from __future__ import annotations

import numpy as np
import soundfile as sf
from scipy import ndimage, signal
from scipy.interpolate import PchipInterpolator


def load_wav_float32(path: str, target_sr: int | None = None) -> tuple[np.ndarray, int]:
    """WAV 로드 후 float32(-1.0~1.0) 표준화 및 리샘플링."""
    audio, sr = sf.read(path, dtype="float32", always_2d=False)
    if target_sr is not None and sr != target_sr:
        gcd = int(np.gcd(sr, target_sr))
        audio = signal.resample_poly(audio, target_sr // gcd, sr // gcd, axis=0).astype(np.float32)
        sr = target_sr
    return audio, sr


def to_mono(audio: np.ndarray) -> np.ndarray:
    return audio.mean(axis=1).astype(np.float32) if audio.ndim == 2 else audio.astype(np.float32)


def declip_and_repair(
    audio: np.ndarray,
    sr: int,
    clip_ratio: float = 0.985,
    min_run: int = 2,
    n_iter: int = 12,
) -> np.ndarray:
    """
    클리핑(소리 깨짐/찢어짐) 자동 탐지 및 복원 알고리즘.
    1) 피크 부근 연속 평탄 구간(clipped run) 탐지
    2) PCHIP(단조 3차 에르미트 보간)으로 1차 파형 재구성
    3) 4kHz 이하 대역 중심 STFT 희소성 반복 투영(간이 A-SPADE 원리)으로
       고역대 클릭 노이즈 없이 찢어진 배음 왜곡 억제
    """
    mono = to_mono(audio)
    peak = float(np.max(np.abs(mono)) + 1e-8)
    if peak < 0.7:
        return mono

    threshold = peak * clip_ratio
    clipped = np.abs(mono) >= threshold

    mask = np.zeros_like(clipped, dtype=bool)
    diff = np.diff(clipped.astype(np.int8), prepend=0, append=0)
    starts = np.where(diff == 1)[0]
    ends = np.where(diff == -1)[0]
    for s, e in zip(starts, ends):
        if (e - s) >= min_run:
            mask[s:e] = True

    if not np.any(mask):
        return mono

    x = mono.copy().astype(np.float64)
    idx_valid = np.where(~mask)[0]
    idx_clip = np.where(mask)[0]
    if len(idx_valid) > 4:
        interp = PchipInterpolator(idx_valid, mono[idx_valid], extrapolate=False)
        repaired = interp(idx_clip)
        valid_rep = ~np.isnan(repaired)
        x[idx_clip[valid_rep]] = repaired[valid_rep]

    n_fft = 2048
    hop = 512
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)
    low_band = freqs <= 4000.0
    sign_orig = np.sign(mono)

    for it in range(n_iter):
        _, _, Z = signal.stft(x, fs=sr, nperseg=n_fft, noverlap=n_fft - hop)
        mag = np.abs(Z)
        lam = np.percentile(mag[low_band], 85) * (0.18 * (1.0 - it / n_iter))
        mag_shrunk = np.where(low_band[:, None], np.maximum(mag - lam, 0.0), mag)
        Z_new = mag_shrunk * np.exp(1j * np.angle(Z))
        _, x_rec = signal.istft(Z_new, fs=sr, nperseg=n_fft, noverlap=n_fft - hop)
        x_rec = x_rec[: len(x)]

        x[~mask] = mono[~mask]
        x[mask] = np.where(
            sign_orig[mask] >= 0,
            np.maximum(x_rec[mask], threshold),
            np.minimum(x_rec[mask], -threshold),
        )

    max_val = float(np.max(np.abs(x)) + 1e-8)
    if max_val > 0.707:
        x = x * (0.707 / max_val)
    return x.astype(np.float32)


def suppress_suno_artifacts(
    audio: np.ndarray,
    sr: int,
    shimmer_band: tuple[float, float] = (4800.0, 8200.0),
    shimmer_strength: float = 0.55,
    resonance_strength: float = 0.60,
    use_external_deshimmer: bool = True,
) -> np.ndarray:
    """
    Suno 보컬 특유의 금속성 쉬머(shimmer) 및 정지 공진(ringing) 억제.
    TheApeMachine/deshimmer 설치 시 우선 호출하고, 미설치 시 자체 Welch PSD + STFT 동적 억제 적용.
    """
    mono = to_mono(audio)
    if shimmer_strength <= 0.0 and resonance_strength <= 0.0:
        return mono

    if use_external_deshimmer and shimmer_strength > 0.0:
        try:
            from deshimmer.api import process_audio
            from deshimmer.core import MasterParams, Params

            params = Params(
                n_fft=2048,
                hop=512,
                start_hz=shimmer_band[0],
                end_hz=shimmer_band[1],
                thr_db=7.5,
                slope=0.55,
                mix=float(np.clip(shimmer_strength, 0.0, 1.0)),
                tonal_repair=0.45,
            )
            mp = MasterParams(enabled=False)
            repaired, _ = process_audio(mono, sr, params=params, master_params=mp)
            return repaired.astype(np.float32)
        except Exception:
            pass

    n_fft = 2048
    hop = 512
    freqs, _, Z = signal.stft(mono, fs=sr, nperseg=n_fft, noverlap=n_fft - hop)
    mag = np.abs(Z) + 1e-8
    phase = np.angle(Z)

    f_psd, psd = signal.welch(mono, fs=sr, nperseg=min(n_fft, len(mono)))
    psd_db = 10.0 * np.log10(psd + 1e-12)
    ksize = min(21, len(psd_db) if len(psd_db) % 2 == 1 else max(1, len(psd_db) - 1))
    smooth_db = signal.medfilt(psd_db, kernel_size=ksize)
    excess_db = np.maximum(psd_db - smooth_db - 4.5, 0.0)

    res_mask = (f_psd >= 2000.0) & (f_psd <= 10000.0)
    res_gain_db = -np.minimum(excess_db * resonance_strength, 8.0) * res_mask
    res_gain = np.interp(freqs, f_psd, 10.0 ** (res_gain_db / 20.0))[:, None]

    band_idx = (freqs >= shimmer_band[0]) & (freqs <= shimmer_band[1])
    gain = res_gain * np.ones_like(mag)

    if np.any(band_idx) and shimmer_strength > 0.0:
        band_mag = mag[band_idx, :]
        geo_mean = np.exp(np.mean(np.log(band_mag + 1e-8), axis=0))
        arith_mean = np.mean(band_mag, axis=0) + 1e-8
        flatness = geo_mean / arith_mean

        ref_level = np.percentile(band_mag, 70, axis=0, keepdims=True)
        over = np.maximum(band_mag - ref_level, 0.0) / (band_mag + 1e-8)
        shimmer_atten = 1.0 - (shimmer_strength * over * np.clip(flatness[None, :] * 1.4, 0.0, 1.0))
        shimmer_atten = np.clip(shimmer_atten, 0.35, 1.0)
        if shimmer_atten.shape[1] > 9:
            shimmer_atten = signal.filtfilt([0.25, 0.5, 0.25], [1.0], shimmer_atten, axis=1)
        gain[band_idx, :] *= shimmer_atten

    Z_clean = (mag * gain) * np.exp(1j * phase)
    _, out = signal.istft(Z_clean, fs=sr, nperseg=n_fft, noverlap=n_fft - hop)
    return out[: len(mono)].astype(np.float32)


def vocal_deesser_and_hpf(
    audio: np.ndarray,
    sr: int,
    hpf_hz: float = 75.0,
    deess_band: tuple[float, float] = (5500.0, 9500.0),
    threshold_db: float = -22.0,
    ratio: float = 3.0,
) -> np.ndarray:
    """초저역 럼블 제거(HPF) + 스플릿 밴드 치찰음 억제(De-esser)."""
    mono = to_mono(audio)
    sos_hp = signal.butter(4, hpf_hz, btype="highpass", fs=sr, output="sos")
    x = signal.sosfiltfilt(sos_hp, mono)

    nyq = sr * 0.5
    hi = min(deess_band[1], nyq * 0.95)
    lo = min(deess_band[0], hi * 0.7)
    sos_sib = signal.butter(4, (lo, hi), btype="bandpass", fs=sr, output="sos")
    sib = signal.sosfiltfilt(sos_sib, x)

    win = max(1, int(sr * 0.005))
    env = np.sqrt(np.convolve(sib**2, np.ones(win) / win, mode="same") + 1e-12)
    env_db = 20.0 * np.log10(env + 1e-12)

    over_db = np.maximum(env_db - threshold_db, 0.0)
    gr_db = np.maximum(-over_db * (1.0 - 1.0 / max(ratio, 1.0)), -9.0)
    gr_lin = 10.0 ** (gr_db / 20.0)

    out = x - sib * (1.0 - gr_lin)
    return out.astype(np.float32)


def true_peak_limiter_and_normalize(
    audio: np.ndarray,
    sr: int,
    target_lufs: float = -15.0,
    ceiling_dbtp: float = -1.0,
    oversample: int = 4,
) -> np.ndarray:
    """
    고속 벡터화 4x 오버샘플링 룩어헤드 트루피크 리미터 + LUFS 정규화.
    """
    mono = to_mono(audio).astype(np.float64)

    try:
        import pyloudnorm as pyln

        meter = pyln.Meter(sr)
        loudness = meter.integrated_loudness(mono)
        if np.isfinite(loudness):
            gain_db = np.clip(target_lufs - loudness, -14.0, 14.0)
            mono = mono * (10.0 ** (gain_db / 20.0))
    except Exception:
        rms = np.sqrt(np.mean(mono**2) + 1e-12)
        target_rms = 10.0 ** (target_lufs / 20.0)
        mono = mono * np.clip(target_rms / rms, 0.25, 4.0)

    up = signal.resample_poly(mono, oversample, 1)
    up_sr = sr * oversample
    ceiling = 10.0 ** (ceiling_dbtp / 20.0)

    hold_win = max(3, int(up_sr * 0.003))
    peak_env = ndimage.maximum_filter1d(np.abs(up), size=hold_win, mode="nearest")
    raw_gain = np.where(peak_env > ceiling, ceiling / (peak_env + 1e-12), 1.0)

    rel_win = max(5, int(up_sr * 0.025))
    kernel = np.hanning(rel_win)
    kernel /= kernel.sum()
    smooth_gain = signal.fftconvolve(raw_gain, kernel, mode="same")
    final_gain = np.minimum(raw_gain, smooth_gain)

    limited = up * final_gain
    limited = ceiling * np.tanh(limited / ceiling)

    out = signal.resample_poly(limited, 1, oversample)[: len(mono)]
    return out.astype(np.float32)
