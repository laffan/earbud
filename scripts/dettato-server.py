"""Run Earbud's local Dettato helper with the environment in the branch README."""
import json
import tempfile
import traceback
from pathlib import Path
from wsgiref.simple_server import make_server

import dettato


ORIGINS = {
    "http://localhost:1420", "http://127.0.0.1:1420",
    "http://localhost:4173", "http://127.0.0.1:4173",
    "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost",
}
MAX_BYTES = 256 * 1024 * 1024


def application(env, start_response):
    headers = [("Content-Type", "application/json"), ("Vary", "Origin")]

    def reply(status, payload):
        start_response(status, headers)
        return [json.dumps(payload, allow_nan=False).encode()]

    origin = env.get("HTTP_ORIGIN")
    if env.get("HTTP_HOST") != "127.0.0.1:17382" or (origin and origin not in ORIGINS):
        return reply("403 Forbidden", {"error": "Unrecognized Earbud origin"})
    if origin:
        headers.append(("Access-Control-Allow-Origin", origin))
    if env["PATH_INFO"] != "/transcribe":
        return reply("404 Not Found", {})
    if env["REQUEST_METHOD"] == "OPTIONS":
        headers.extend([("Access-Control-Allow-Methods", "POST"),
                        ("Access-Control-Allow-Headers", "Content-Type"),
                        ("Access-Control-Allow-Private-Network", "true")])
        return reply("200 OK", {})
    if env["REQUEST_METHOD"] != "POST" or env.get("CONTENT_TYPE") != "audio/wav":
        return reply("400 Bad Request", {"error": "Expected an audio/wav POST"})
    try:
        remaining = int(env.get("CONTENT_LENGTH") or 0)
    except ValueError:
        remaining = 0
    if not 0 < remaining <= MAX_BYTES:
        return reply("413 Payload Too Large", {"error": "Expected a WAV of up to 256 MiB"})
    try:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "analysis.wav"
            with path.open("wb") as out:
                while remaining:
                    chunk = env["wsgi.input"].read(min(remaining, 1024 * 1024))
                    if not chunk:
                        return reply("400 Bad Request", {"error": "Incomplete WAV"})
                    out.write(chunk)
                    remaining -= len(chunk)
            result = dettato.transcribe(str(path))
        notes = [
            dict(startTime=float(start), endTime=float(end), pitch=int(pitch), velocity=int(velocity))
            for track in result.tracks if not track.is_drum
            for start, end, pitch, velocity in track.notes if end > start
        ]
        notes.sort(key=lambda note: (note["startTime"], note["pitch"]))
        return reply("200 OK", notes)
    except Exception as error:
        traceback.print_exc()
        return reply("500 Internal Server Error", {"error": f"Dettato: {error}"})


if __name__ == "__main__":
    with make_server("127.0.0.1", 17382, application) as server:
        print("Earbud Dettato helper listening on 127.0.0.1:17382", flush=True)
        server.serve_forever()
