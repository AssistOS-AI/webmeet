import os
import tempfile
from functools import lru_cache

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse
from faster_whisper import WhisperModel


MODEL_NAME = os.environ.get("WHISPER_MODEL", "base").strip() or "base"
LANGUAGE = os.environ.get("WHISPER_LANGUAGE", "auto").strip() or "auto"
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu").strip() or "cpu"
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE_TYPE", "int8").strip() or "int8"
PORT = int(os.environ.get("WEBMEET_STT_PORT", "9000"))

app = FastAPI(title="WebMeet Faster-Whisper STT", version="1.0.0")


@lru_cache(maxsize=1)
def get_model():
    return WhisperModel(
        MODEL_NAME,
        device=DEVICE,
        compute_type=COMPUTE_TYPE,
        download_root="/data/models",
    )


@app.get("/healthz")
async def healthz():
    return {"ok": True, "model": MODEL_NAME, "device": DEVICE}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form("whisper-1"),
    language: str = Form(""),
    response_format: str = Form("json"),
):
    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as handle:
        audio_path = handle.name
        handle.write(await file.read())
    try:
        selected_language = (language or LANGUAGE).strip()
        kwargs = {}
        if selected_language and selected_language.lower() != "auto":
            kwargs["language"] = selected_language
        segments, info = get_model().transcribe(audio_path, **kwargs)
        text = " ".join(segment.text.strip() for segment in segments if segment.text and segment.text.strip()).strip()
    except Exception as exc:
        raise HTTPException(status_code=500, detail="STT transcription failed") from exc
    finally:
        try:
            os.unlink(audio_path)
        except OSError:
            pass

    if response_format == "text":
        return PlainTextResponse(text)
    return JSONResponse({
        "text": text,
        "language": getattr(info, "language", None),
        "duration": getattr(info, "duration", None),
    })


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
