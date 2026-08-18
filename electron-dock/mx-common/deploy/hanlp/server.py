"""Minimal HanLP tokenization service.

Exposes exactly the one endpoint mx-common's segmenter client calls:

    POST /tokenize  {"text": "...", "coarse": true}  ->  [["token", ...]]

Kept to a single capability on purpose. HanLP can do POS tagging, NER, SRL and
dependency parsing, and every one of those loads another model into memory. This
service exists so Elasticsearch can index Chinese text without an in-cluster
analyzer plugin; anything beyond word segmentation belongs in the Hub agent, not
in a shared, always-on tokenizer.

The model is resolved once at import and reused. First load downloads weights to
HANLP_HOME, so the container needs a persistent volume there or a warm image;
readiness stays false until the model is in memory.
"""

import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import sys
import threading
import traceback

# Coarse-grained ("CTB-style") segmentation keeps multi-character terms such as
# 人工智能 and brand names intact. Fine-grained models split them, which hurts
# search precision far more than it helps recall.
MODEL_NAME = os.environ.get("HANLP_MODEL", "COARSE_ELECTRA_SMALL_ZH")
PORT = int(os.environ.get("PORT", "8000"))
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", "1048576"))
# A rebuild segments hundreds of thousands of records. HanLP's own API is
# batch-shaped -- it takes a list of texts and returns a list of token lists --
# so sending one text per HTTP request pays the model handoff, the HTTP round
# trip and the Python dispatch once per record instead of once per batch. The
# bound keeps a single caller from monopolising the inference slot.
MAX_BATCH_TEXTS = int(os.environ.get("MAX_BATCH_TEXTS", "256"))
# A HanLP component is one mutable Python object. Keep forward passes serialized
# unless an operator has explicitly validated a particular model as thread-safe.
# Waiting briefly is important: the Hub projector segments several fields in
# parallel, so a non-blocking slot would routinely degrade otherwise healthy
# requests to the local fallback.
MAX_CONCURRENT_INFERENCES = int(os.environ.get("MAX_CONCURRENT_INFERENCES", "1"))
INFERENCE_QUEUE_TIMEOUT_SECONDS = float(
    os.environ.get("INFERENCE_QUEUE_TIMEOUT_SECONDS", "3")
)
WARMUP_TEXT = "吴恩达与人工智能"

_tokenizer = None
_load_error = None
_lock = threading.Lock()
_inference_slots = threading.BoundedSemaphore(MAX_CONCURRENT_INFERENCES)


def _log_safe_traceback(context, error):
    """Log diagnostic frames without reflecting request text or exception data."""
    print(f"[hanlp] {context}: {type(error).__name__}", file=sys.stderr)
    traceback.print_tb(error.__traceback__, file=sys.stderr)


def _warm_up(tokenizer):
    tokens = tokenizer([WARMUP_TEXT])
    has_token = isinstance(tokens, list) and any(
        isinstance(sentence, list)
        and any(isinstance(token, str) and token.strip() for token in sentence)
        for sentence in tokens
    )
    if not has_token:
        raise RuntimeError("tokenizer warm-up returned no tokens")


def _load_model():
    global _tokenizer, _load_error
    with _lock:
        if _tokenizer is not None or _load_error is not None:
            return
        try:
            import hanlp  # imported lazily so the process starts before weights load

            candidate = hanlp.load(getattr(hanlp.pretrained.tok, MODEL_NAME))
            # Loading weights alone does not exercise the transformers forward
            # API. Warm up before publishing readiness so an incompatible
            # dependency fails closed instead of making every request return 500.
            _warm_up(candidate)
            _tokenizer = candidate
        except Exception as error:  # noqa: BLE001 - surfaced through /health
            _load_error = f"{type(error).__name__}: model warm-up failed"
            _log_safe_traceback("model load or warm-up failed", error)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path.startswith("/health"):
            if _tokenizer is not None:
                self._send(200, {"status": "ready", "model": MODEL_NAME})
            elif _load_error is not None:
                self._send(503, {"status": "failed", "error": _load_error})
            else:
                self._send(503, {"status": "loading", "model": MODEL_NAME})
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler API
        if not self.path.startswith("/tokenize"):
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            self._send(400, {"error": "invalid content-length"})
            return
        if length < 0 or length > MAX_BODY_BYTES:
            self.close_connection = True
            self._send(413, {"error": f"request body exceeds {MAX_BODY_BYTES} bytes"})
            return
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "invalid JSON body"})
            return

        if _tokenizer is None:
            self._send(503, {"error": _load_error or "model is still loading"})
            return

        batch = self.path.rstrip("/").endswith("/batch")
        if batch:
            texts = request.get("texts")
            if not isinstance(texts, list) or not all(isinstance(item, str) for item in texts):
                self._send(400, {"error": "texts must be an array of strings"})
                return
            if len(texts) > MAX_BATCH_TEXTS:
                self._send(400, {"error": f"texts exceeds {MAX_BATCH_TEXTS} items"})
                return
            if not texts:
                self._send(200, {"batch": []})
                return
            # Same per-text bound as the single path: one oversized document
            # must not stall the shared tokenizer for every other caller.
            inputs = [item[:20_000] for item in texts]
        else:
            text = request.get("text") or ""
            if not isinstance(text, str):
                self._send(400, {"error": "text must be a string"})
                return
            inputs = [text[:20_000]]

        if not _inference_slots.acquire(timeout=INFERENCE_QUEUE_TIMEOUT_SECONDS):
            self._send(429, {"error": "tokenizer is busy"})
            return
        try:
            try:
                # HanLP's native tokenizer API is batch-shaped, so a batch of N
                # is one forward pass rather than N of them.
                tokens = _tokenizer(inputs)
            except Exception as error:  # noqa: BLE001
                _log_safe_traceback("tokenizer inference failed", error)
                self._send(500, {"error": "tokenizer inference failed"})
                return
        finally:
            _inference_slots.release()

        # Normalize to the list-of-sentences shape the Node client expects.
        if tokens and isinstance(tokens[0], str):
            tokens = [tokens]
        if not batch:
            self._send(200, tokens)
            return
        # One token list per input, positionally. A short result would silently
        # misalign tokens with records, so it is refused rather than padded.
        if not isinstance(tokens, list) or len(tokens) != len(inputs):
            self._send(500, {"error": "tokenizer returned a misaligned batch"})
            return
        self._send(200, {"batch": tokens})

    def log_message(self, *_args):
        # Default handler logs every request to stderr; too noisy for an
        # always-on tokenizer behind a projector.
        return


if __name__ == "__main__":
    threading.Thread(target=_load_model, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
