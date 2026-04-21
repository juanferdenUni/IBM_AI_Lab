import asyncio
from collections.abc import AsyncGenerator
from faster_whisper import WhisperModel
from backend.config import settings

_whisper_model: WhisperModel | None = None


def _get_model() -> WhisperModel:
    global _whisper_model
    if _whisper_model is None:
        _whisper_model = WhisperModel(settings.whisper_model_size, device="cpu", compute_type="int8")
    return _whisper_model


async def transcribe_chunks(
    audio_path: str,
    chunk_seconds: int = 30,
    overlap_seconds: int = 5,
) -> AsyncGenerator[dict[str, object], None]:
    loop = asyncio.get_event_loop()

    try:
        model = await loop.run_in_executor(None, _get_model)
        segments, _ = await loop.run_in_executor(
            None,
            lambda: model.transcribe(audio_path, beam_size=5),
        )
        segments = list(segments)
    except Exception as e:
        raise WhisperError(f"Failed to load or transcribe audio: {e}") from e

    chunk_index = 0
    current_chunk_texts: list[str] = []
    current_chunk_start: float = 0.0
    chunk_end_time: float = chunk_seconds

    for i, segment in enumerate(segments):
        is_last_segment = i == len(segments) - 1

        if segment.start >= chunk_end_time and current_chunk_texts:
            yield {
                "chunk_index": chunk_index,
                "text": " ".join(current_chunk_texts).strip(),
                "start_ms": int(current_chunk_start * 1000),
                "end_ms": int(segment.start * 1000),
                "is_final": False,
            }
            chunk_index += 1
            current_chunk_start = max(segment.start - overlap_seconds, 0.0)
            chunk_end_time = current_chunk_start + chunk_seconds
            current_chunk_texts = []

        current_chunk_texts.append(segment.text.strip())

        if is_last_segment and current_chunk_texts:
            yield {
                "chunk_index": chunk_index,
                "text": " ".join(current_chunk_texts).strip(),
                "start_ms": int(current_chunk_start * 1000),
                "end_ms": int(segment.end * 1000),
                "is_final": True,
            }


class WhisperError(Exception):
    """faster-whisper model load failure or segment transcription failure."""
    ...
