from __future__ import annotations

from datetime import date, datetime
from enum import Enum
from typing import Any

try:
    import numpy as np
except Exception:
    np = None


def to_bson_safe(value: Any) -> Any:
    """Convert telemetry-only values to BSON-safe Python primitives recursively."""
    if np is not None:
        if isinstance(value, np.ndarray):
            return [to_bson_safe(item) for item in value.tolist()]
        if isinstance(value, np.generic):
            return to_bson_safe(value.item())
    if isinstance(value, dict):
        return {str(key): to_bson_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_bson_safe(item) for item in value]
    if isinstance(value, Enum):
        return to_bson_safe(value.value)
    if isinstance(value, (str, int, float, bool, type(None), datetime, date)):
        return value
    return str(value)
