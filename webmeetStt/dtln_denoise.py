import logging
import os
import tempfile
import wave
from functools import lru_cache

logger = logging.getLogger(__name__)

DENOISE_MODE = os.environ.get("WEBMEET_STT_DENOISE", "dtln").strip().lower() or "dtln"
_BLOCK_LEN = 512
_BLOCK_SHIFT = 128


def _np():
    import numpy as np

    return np


def is_enabled() -> bool:
    return DENOISE_MODE == "dtln"


@lru_cache(maxsize=1)
def _get_suppressor():
    from livekit.plugins.dtln.noise_suppressor import DTLNNoiseSuppressor

    return DTLNNoiseSuppressor()


def _infer_block(suppressor, block):
    infer = getattr(suppressor, "_infer_block", None)
    if not callable(infer):
        raise RuntimeError("Installed DTLN plugin does not expose the expected block inference adapter.")
    return infer(block)


def _read_wav(path):
    np = _np()
    with wave.open(path, "rb") as reader:
        sample_rate = reader.getframerate()
        channels = reader.getnchannels()
        sample_width = reader.getsampwidth()
        frames = reader.readframes(reader.getnframes())
    if sample_width != 2:
        raise ValueError("DTLN denoise expects 16-bit PCM WAV input.")
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return sample_rate, samples


def _write_wav(path, sample_rate, samples):
    np = _np()
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16)
    with wave.open(path, "wb") as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(sample_rate)
        writer.writeframes(pcm.tobytes())


def _process_samples(samples):
    np = _np()
    suppressor = _get_suppressor()
    in_buf = np.zeros(_BLOCK_LEN, dtype=np.float32)
    out_buf = np.zeros(_BLOCK_LEN, dtype=np.float32)
    output = []
    padded = np.pad(samples.astype(np.float32), (0, _BLOCK_SHIFT))
    for start in range(0, len(padded), _BLOCK_SHIFT):
        block = padded[start:start + _BLOCK_SHIFT]
        if len(block) < _BLOCK_SHIFT:
            block = np.pad(block, (0, _BLOCK_SHIFT - len(block)))
        in_buf[:-_BLOCK_SHIFT] = in_buf[_BLOCK_SHIFT:]
        in_buf[-_BLOCK_SHIFT:] = block
        denoised = _infer_block(suppressor, in_buf)
        out_buf[:-_BLOCK_SHIFT] = out_buf[_BLOCK_SHIFT:]
        out_buf[-_BLOCK_SHIFT:] = 0.0
        out_buf += denoised
        output.append(out_buf[:_BLOCK_SHIFT].copy())
    return np.concatenate(output)[:len(samples)]


def denoise_file(input_path):
    if not is_enabled():
        return input_path
    output_path = None
    try:
        sample_rate, samples = _read_wav(input_path)
        if sample_rate != 16000:
            logger.warning("Skipping DTLN denoise for unsupported sample rate: %s", sample_rate)
            return input_path
        handle = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
        output_path = handle.name
        handle.close()
        _write_wav(output_path, sample_rate, _process_samples(samples))
        return output_path
    except Exception as exc:
        if output_path and os.path.exists(output_path):
            try:
                os.unlink(output_path)
            except OSError:
                logger.warning("Failed to remove incomplete DTLN temp file: %s", output_path)
        logger.warning("DTLN denoise failed; using original audio: %s", exc)
        return input_path
