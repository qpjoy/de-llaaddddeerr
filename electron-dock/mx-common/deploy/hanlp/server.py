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
import threading

# Coarse-grained ("CTB-style") segmentation keeps multi-character terms such as
# 人工智能 and brand names intact. Fine-grained models split them, which hurts
# search precision far more than it helps recall.
MODEL_NAME = os.environ.get("HANLP_MODEL", "COARSE_ELECTRA_SMALL_ZH")
PORT = int(os.environ.get("PORT", "8000"))
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", "65536"))
MAX_CONCURRENT_INFERENCES = int(os.environ.get("MAX_CONCURRENT_INFERENCES", "2"))

_tokenizer = None
_load_error = None
_lock = threading.Lock()
_inference_slots = threading.BoundedSemaphore(MAX_CONCURRENT_INFERENCES)


def _load_model():
    global _tokenizer, _load_error
    with _lock:
        if _tokenizer is not None or _load_error is not None:
            return
        try:
            import hanlp  # imported lazily so the process starts before weights load

            _tokenizer = hanlp.load(getattr(hanlp.pretrained.tok, MODEL_NAME))
        except Exception as error:  # noqa: BLE001 - surfaced through /health
            _load_error = str(error)


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

        text = request.get("text") or ""
        if not isinstance(text, str):
            self._send(400, {"error": "text must be a string"})
            return
        # Bound the input: a single oversized document must not stall the shared
        # tokenizer for every other caller.
        text = text[:20_000]
        if not _inference_slots.acquire(blocking=False):
            self._send(429, {"error": "tokenizer is busy"})
            return
        try:
            try:
                tokens = _tokenizer(text)
            except Exception as error:  # noqa: BLE001
                self._send(500, {"error": str(error)})
                return
        finally:
            _inference_slots.release()
        # Normalize to the list-of-sentences shape the Node client expects.
        if tokens and isinstance(tokens[0], str):
            tokens = [tokens]
        self._send(200, tokens)

    def log_message(self, *_args):
        # Default handler logs every request to stderr; too noisy for an
        # always-on tokenizer behind a projector.
        return


if __name__ == "__main__":
    threading.Thread(target=_load_model, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
