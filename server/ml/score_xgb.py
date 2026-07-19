#!/usr/bin/env python3
"""
XGBoost fraud-chance scorer for Grant Fraud Watch.

Trains on facilities that already have a multi-signal (or Benford) target score,
then predicts for all rows.

stdin JSON:
{
  "facilities": [
    {
      "id": "...",
      "targetScore": 42,          # multi-signal score (preferred) or benford
      "confidence": "high"|"low"|"model"|"none",
      "features": { ... extended feature dict ... }
    }
  ]
}
"""

from __future__ import annotations

import json
import math
import sys
from typing import Any


def fail(msg: str) -> None:
    json.dump(
        {
            "ok": False,
            "xgbEnabled": False,
            "trainedOn": 0,
            "predictions": {},
            "error": msg,
        },
        sys.stdout,
    )


def feature_vector(features: dict[str, Any], keys: list[str]) -> list[float]:
    out: list[float] = []
    for k in keys:
        v = features.get(k, 0)
        try:
            x = float(v)
            if not math.isfinite(x):
                x = 0.0
        except (TypeError, ValueError):
            x = 0.0
        out.append(x)
    return out


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        fail(f"invalid json: {e}")
        return

    facilities = payload.get("facilities") or []
    if not isinstance(facilities, list) or len(facilities) == 0:
        json.dump(
            {
                "ok": True,
                "xgbEnabled": False,
                "trainedOn": 0,
                "predictions": {},
                "message": "no facilities",
            },
            sys.stdout,
        )
        return

    try:
        import numpy as np
        import xgboost as xgb
    except ImportError as e:
        fail(f"xgboost/numpy not installed: {e}. Run: pip install xgboost numpy")
        return

    # Union of all feature keys for a consistent matrix
    key_set: set[str] = set()
    for f in facilities:
        feats = f.get("features") or {}
        if isinstance(feats, dict):
            key_set.update(feats.keys())
    feature_keys = sorted(key_set)
    if not feature_keys:
        fail("no features")
        return

    X_train: list[list[float]] = []
    y_train: list[float] = []
    train_ids: set[str] = set()
    all_ids: list[str] = []
    X_all: list[list[float]] = []

    for f in facilities:
        fid = str(f.get("id", ""))
        feats = f.get("features") or {}
        x = feature_vector(feats, feature_keys)
        all_ids.append(fid)
        X_all.append(x)

        conf = f.get("confidence")
        # Prefer multi-signal targetScore; fall back to benfordScore
        score = f.get("targetScore")
        if score is None:
            score = f.get("benfordScore")

        if score is not None and conf in ("high", "low", "model"):
            try:
                y = float(score)
            except (TypeError, ValueError):
                continue
            if math.isfinite(y):
                y = max(0.0, min(100.0, y))
                weight = 2 if conf == "high" else 1
                for _ in range(weight):
                    X_train.append(x)
                    y_train.append(y)
                train_ids.add(fid)

    if len(train_ids) < 6 or len(y_train) < 8:
        json.dump(
            {
                "ok": True,
                "xgbEnabled": False,
                "trainedOn": len(train_ids),
                "predictions": {},
                "message": "need more scored facilities to train XGBoost",
            },
            sys.stdout,
        )
        return

    X = np.asarray(X_train, dtype=np.float64)
    y = np.asarray(y_train, dtype=np.float64)
    X_pred = np.asarray(X_all, dtype=np.float64)

    dtrain = xgb.DMatrix(X, label=y, feature_names=feature_keys)
    dpred = xgb.DMatrix(X_pred, feature_names=feature_keys)

    params = {
        "objective": "reg:squarederror",
        "max_depth": 5,
        "eta": 0.07,
        "subsample": 0.9,
        "colsample_bytree": 0.85,
        "lambda": 1.2,
        "min_child_weight": 2,
        "seed": 42,
        "nthread": 2,
        "verbosity": 0,
    }
    model = xgb.train(params, dtrain, num_boost_round=100)
    preds = model.predict(dpred)

    predictions = {
        fid: float(max(0.0, min(100.0, float(p))))
        for fid, p in zip(all_ids, preds)
    }

    json.dump(
        {
            "ok": True,
            "xgbEnabled": True,
            "trainedOn": len(train_ids),
            "predictions": predictions,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
