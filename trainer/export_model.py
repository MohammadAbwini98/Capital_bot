#!/usr/bin/env python3
"""
export_model.py — Re-export the current model to models/current.json
without retraining (useful if you want to promote a specific archived
version, or test a manually-crafted baseline).

Usage:
  # Re-export current (already trained by train.py)
  python trainer/export_model.py

  # Promote a specific archived version
  python trainer/export_model.py models/model_2026-02-24_02.json

After exporting, the bot picks up the new model automatically on the
next mlModel.reload() call (triggered at each startup).  For hot-reload
without restart, call mlModel.reload() from a webhook or SIGHUP handler.
"""

import os
import sys
import json
import shutil

MODELS_DIR   = os.path.join(os.path.dirname(__file__), '..', 'models')
CURRENT_PATH = os.path.join(MODELS_DIR, 'current.json')


def validate(model: dict) -> bool:
    required = ['model_version', 'feature_names', 'bias', 'weights']
    for key in required:
        if key not in model:
            print(f'ERROR: missing key "{key}" in model JSON')
            return False
    return True


def main():
    if len(sys.argv) > 1:
        src = sys.argv[1]
        if not os.path.exists(src):
            sys.exit(f'File not found: {src}')
        with open(src) as f:
            model = json.load(f)
        if not validate(model):
            sys.exit(1)
        shutil.copy2(src, CURRENT_PATH)
        print(f'Promoted {src} → {CURRENT_PATH}')
        print(f'  version: {model["model_version"]}')
        print(f'  features: {len(model["feature_names"])}')
    else:
        if not os.path.exists(CURRENT_PATH):
            sys.exit(f'No model at {CURRENT_PATH} — run trainer/train.py first')
        with open(CURRENT_PATH) as f:
            model = json.load(f)
        if not validate(model):
            sys.exit(1)
        print(f'Current model is already at {CURRENT_PATH}')
        print(f'  version: {model["model_version"]}')
        print(f'  features: {len(model["feature_names"])}')
        print()
        print('Weights:')
        for name, w in model['weights'].items():
            print(f'  {name:35s} {w:+.6f}')


if __name__ == '__main__':
    main()
