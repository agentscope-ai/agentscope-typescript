#!/usr/bin/env python3
"""Generate TTS model-card outputs from the pinned Python source."""

import json
import subprocess
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
PYTHON_ROOT = REPOSITORY_ROOT.parent / "agentscope-python"
PYTHON_SOURCE = PYTHON_ROOT / "src"
EXPECTED_COMMIT = "de163b34b909edaba3c174190ad7e1a355e7849f"
OUTPUT = (
    REPOSITORY_ROOT
    / "packages"
    / "agentscope"
    / "test"
    / "parity"
    / "fixtures"
    / "tts-model-cards.python.json"
)

if not PYTHON_SOURCE.is_dir():
    raise RuntimeError(f"Pinned Python source is missing at {PYTHON_SOURCE}.")

actual_commit = subprocess.check_output(
    ["git", "rev-parse", "HEAD"],
    cwd=PYTHON_ROOT,
    text=True,
).strip()
if actual_commit != EXPECTED_COMMIT:
    raise RuntimeError(
        f"Expected Python commit {EXPECTED_COMMIT}, got {actual_commit}.",
    )

sys.path.insert(0, str(PYTHON_SOURCE))

from agentscope.tts import (  # noqa: E402
    DashScopeCosyVoiceTTSModel,
    DashScopeRealtimeTTSModel,
    DashScopeTTSModel,
    GeminiTTSModel,
    OpenAITTSModel,
)

MODEL_CLASSES = [
    OpenAITTSModel,
    GeminiTTSModel,
    DashScopeTTSModel,
    DashScopeRealtimeTTSModel,
    DashScopeCosyVoiceTTSModel,
]

payload = {
    "python_commit": actual_commit,
    "classes": {
        model_class.__name__: [
            card.model_dump(mode="json")
            for card in model_class.list_models()
        ]
        for model_class in MODEL_CLASSES
    },
}
OUTPUT.write_text(
    json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
print(f"Wrote {OUTPUT}")
