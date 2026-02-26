"""
run_phi.py — Redactor server (localhost:8765)

Endpoints:
  POST /redact   — run all detection layers, return redacted text + map
  POST /restore  — swap tokens back to original values
  GET  /status   — server health + model availability
  OPTIONS *      — CORS preflight

Start:  python run_phi.py
"""

import json
import re
import sys
import threading
from collections import defaultdict
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

# ── Model loading ───────────────────────────────────────────────────────────

print("Loading spaCy en_core_web_lg…", flush=True)
try:
    import spacy
    _nlp = spacy.load("en_core_web_lg")
    SPACY_AVAILABLE = True
    print("spaCy ready.", flush=True)
except Exception as _e:
    _nlp = None
    SPACY_AVAILABLE = False
    print(f"Warning: spaCy unavailable ({_e}). Layer 2 disabled.", flush=True)

print("Loading Phi-3 Mini…", flush=True)
try:
    from mlx_lm import load as _mlx_load, generate as _mlx_generate
    _phi3_model, _phi3_tokenizer = _mlx_load(
        "mlx-community/Phi-3-mini-4k-instruct-4bit"
    )
    PHI3_AVAILABLE = True
    _PHI3_LOCK = threading.Lock()
    print("Phi-3 ready.", flush=True)
except ImportError:
    print("Warning: mlx-lm not installed. Deep Scan disabled.", flush=True)
    _phi3_model = _phi3_tokenizer = None
    PHI3_AVAILABLE = False
    _PHI3_LOCK = threading.Lock()
except Exception as _e:
    print(f"Warning: Phi-3 failed to load ({_e}). Deep Scan disabled.", flush=True)
    _phi3_model = _phi3_tokenizer = None
    PHI3_AVAILABLE = False
    _PHI3_LOCK = threading.Lock()

# ── Regex patterns ──────────────────────────────────────────────────────────

_PATTERNS = [
    ("EMAIL", re.compile(
        r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"
    )),
    ("URL", re.compile(
        r"https?://[^\s\"'<>]+"
        r"|(?<!\w)(?:www\.)[A-Za-z0-9.\-]+\.[A-Za-z]{2,}(?:/[^\s\"'<>]*)?"
    )),
    ("PHONE", re.compile(
        r"(?:\+44\s?|0)(?:\d[\s\-]?){9,10}\d"
    )),
    ("POSTCODE", re.compile(
        r"\b[A-Z]{1,2}\d{1,2}[A-Z]?\s?\d[A-Z]{2}\b", re.IGNORECASE
    )),
    ("TAX", re.compile(
        r"\bGB\s?\d{3}\s?\d{4}\s?\d{2}\b", re.IGNORECASE
    )),
    ("NI", re.compile(
        r"\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b",
        re.IGNORECASE,
    )),
    ("DATE", re.compile(
        r"\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b"
        r"|\b(?:January|February|March|April|May|June|July|August|September"
        r"|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)"
        r"[\s,]+\d{1,2}[\s,]+\d{4}\b"
        r"|\b\d{1,2}[\s]+"
        r"(?:January|February|March|April|May|June|July|August|September"
        r"|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)"
        r"[\s,]+\d{4}\b",
        re.IGNORECASE,
    )),
    ("CURRENCY", re.compile(r"£\s?\d[\d,]*(?:\.\d{2})?")),
]

# spaCy entity label → canonical token prefix
_SPACY_LABEL_MAP = {
    "PERSON": "PERSON",
    "ORG":    "COMPANY",
    "GPE":    "ADDRESS",
    "LOC":    "ADDRESS",
    "FAC":    "ADDRESS",
}

# Phi-3 type string → canonical token prefix
_PHI3_LABEL_MAP = {
    "PERSON":   "PERSON",
    "NAME":     "PERSON",
    "ORG":      "COMPANY",
    "COMPANY":  "COMPANY",
    "ORGANIZATION": "COMPANY",
    "ADDRESS":  "ADDRESS",
    "LOCATION": "ADDRESS",
    "GPE":      "ADDRESS",
    "PHONE":    "PHONE",
    "EMAIL":    "EMAIL",
    "URL":      "URL",
    "DATE":     "DATE",
    "TAX":      "TAX",
    "NI":       "NI",
    "POSTCODE": "POSTCODE",
    "CURRENCY": "CURRENCY",
}


# ── Detection helpers ───────────────────────────────────────────────────────

def _regex_entities(text: str) -> list:
    """Return list of (label, value, start, end)."""
    results = []
    for label, pat in _PATTERNS:
        for m in pat.finditer(text):
            results.append((label, m.group(), m.start(), m.end()))
    return results


def _spacy_entities(text: str) -> list:
    """Return list of (label, value, start, end)."""
    if not SPACY_AVAILABLE or _nlp is None:
        return []
    doc = _nlp(text)
    results = []
    for ent in doc.ents:
        label = _SPACY_LABEL_MAP.get(ent.label_)
        if label:
            results.append((label, ent.text, ent.start_char, ent.end_char))
    return results


def _phi3_entities(text: str) -> list:
    """Return list of (label, value) — no positions."""
    if not PHI3_AVAILABLE:
        return []

    CHUNK = 1000
    OVERLAP = 100
    words = text.split()
    chunks = []
    i = 0
    while i < len(words):
        chunks.append(" ".join(words[i: i + CHUNK]))
        i += CHUNK - OVERLAP

    prompt_body = (
        "List every piece of sensitive information in this text that could "
        "identify a person or business. Include names, companies, addresses, "
        "phone numbers, tax IDs, and any other PII. Return as a JSON array of "
        "{type, value} objects only. No explanation, no markdown, just the "
        "JSON array.\n\nText:\n"
    )

    results = []
    for chunk in chunks:
        prompt = f"<|user|>\n{prompt_body}{chunk}<|end|>\n<|assistant|>\n"
        try:
            with _PHI3_LOCK:
                raw = _mlx_generate(
                    _phi3_model, _phi3_tokenizer,
                    prompt=prompt, max_tokens=500,
                )
            match = re.search(r"\[.*?\]", raw, re.DOTALL)
            if match:
                items = json.loads(match.group())
                for item in items:
                    if isinstance(item, dict):
                        t = str(item.get("type", "")).upper()
                        v = str(item.get("value", "")).strip()
                        if v:
                            label = _PHI3_LABEL_MAP.get(t, "PERSON")
                            results.append((label, v))
        except Exception:
            continue

    return results


# ── Redaction core ──────────────────────────────────────────────────────────

def _redact(text: str, deep_scan: bool = False) -> dict:
    """
    Run all detection layers and return redacted text + token map + counts.
    """
    # Collect positioned entities from layers 1 & 2
    raw = []
    raw.extend(_regex_entities(text))
    raw.extend(_spacy_entities(text))

    # Layer 3: Phi-3 (returns value strings without positions)
    phi3_pairs = []
    if deep_scan:
        phi3_pairs = _phi3_entities(text)

    # Track first-seen original casing per normalised value
    first_seen = {}
    for _, value, _, _ in raw:
        first_seen.setdefault(value.strip().lower(), value)
    for _, value in phi3_pairs:
        first_seen.setdefault(value.strip().lower(), value)

    # Sort by span length descending so longer matches win overlapping spans
    raw.sort(key=lambda x: -(x[3] - x[2]))

    occupied = []

    def overlaps(s, e):
        return any(s < b and e > a for a, b in occupied)

    clean = []
    for label, value, start, end in raw:
        if not overlaps(start, end):
            occupied.append((start, end))
            clean.append((label, value, start, end))

    # Resolve Phi-3 values to positions via regex search
    for label, value in phi3_pairs:
        for m in re.finditer(re.escape(value), text, re.IGNORECASE):
            if not overlaps(m.start(), m.end()):
                occupied.append((m.start(), m.end()))
                clean.append((label, m.group(), m.start(), m.end()))
                first_seen.setdefault(m.group().strip().lower(), m.group())

    clean.sort(key=lambda x: x[2])

    # Assign deterministic tokens
    counters = defaultdict(int)
    norm_to_token = {}

    def assign(label, value):
        key = value.strip().lower()
        if key in norm_to_token:
            return norm_to_token[key]
        counters[label] += 1
        token = f"[{label}_{counters[label]}]"
        norm_to_token[key] = token
        return token

    # Build output
    parts = []
    cursor = 0
    token_map = {}
    counts = defaultdict(int)

    for label, value, start, end in clean:
        parts.append(text[cursor:start])
        token = assign(label, value)
        norm = value.strip().lower()
        token_map[token] = first_seen.get(norm, value)
        parts.append(token)
        cursor = end
        counts[label] += 1

    parts.append(text[cursor:])

    return {
        "redacted_text": "".join(parts),
        "map": dict(token_map),
        "entity_counts": dict(counts),
    }


def _restore(text: str, token_map: dict) -> dict:
    # Replace longest tokens first to avoid partial substitutions
    for token in sorted(token_map, key=len, reverse=True):
        text = text.replace(token, str(token_map[token]))
    return {"restored_text": text}


# ── HTTP handler ────────────────────────────────────────────────────────────

_CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


class Handler(BaseHTTPRequestHandler):

    # ── routing ───────────────────────────────────────────────────────────

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in _CORS.items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        if self.path == "/status":
            self._handle_status()
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        body = self._read_body()
        if body is None:
            return
        if self.path == "/redact":
            self._handle_redact(body)
        elif self.path == "/restore":
            self._handle_restore(body)
        else:
            self._send_json(404, {"error": "not found"})

    # ── endpoint handlers ─────────────────────────────────────────────────

    def _handle_status(self):
        self._send_json(200, {
            "status": "ok",
            "spacy": SPACY_AVAILABLE,
            "phi3": PHI3_AVAILABLE,
            "model": "Phi-3-mini-4k-instruct-4bit" if PHI3_AVAILABLE else None,
        })

    def _handle_redact(self, body: dict):
        text = body.get("text", "")
        if not isinstance(text, str) or not text.strip():
            self._send_json(400, {"error": "'text' field required"})
            return
        deep_scan = bool(body.get("deep_scan", False))
        try:
            self._send_json(200, _redact(text, deep_scan=deep_scan))
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def _handle_restore(self, body: dict):
        text = body.get("text", "")
        token_map = body.get("map", {})
        if not isinstance(text, str):
            self._send_json(400, {"error": "'text' field required"})
            return
        if not isinstance(token_map, dict):
            self._send_json(400, {"error": "'map' must be an object"})
            return
        try:
            self._send_json(200, _restore(text, token_map))
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    # ── helpers ───────────────────────────────────────────────────────────

    def _read_body(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            return json.loads(self.rfile.read(length))
        except Exception as exc:
            self._send_json(400, {"error": f"invalid JSON: {exc}"})
            return None

    def _send_json(self, status: int, data: dict):
        payload = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for k, v in _CORS.items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):
        print(f"  {args[0]}  {args[1]}", flush=True)


# ── Server startup ──────────────────────────────────────────────────────────

class _ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


if __name__ == "__main__":
    server = _ThreadedHTTPServer(("localhost", 8765), Handler)
    print("\nRedactor server ready on http://localhost:8765", flush=True)
    print(f"  spaCy : {'ready' if SPACY_AVAILABLE else 'disabled'}", flush=True)
    print(f"  Phi-3 : {'ready' if PHI3_AVAILABLE else 'disabled'}", flush=True)
    print("  Press Ctrl+C to stop\n", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
        sys.exit(0)
