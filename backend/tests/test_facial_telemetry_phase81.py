import base64
import io
import time

import numpy as np
from PIL import Image

from backend.services.face_recognition_service import FaceEmbeddingRecord, FaceRecognitionService


class Detector:
    def __init__(self, detections):
        self.detections = np.asarray(detections, dtype=np.float32)

    def detect(self, image, max_num=0, metric="default"):
        return self.detections, np.zeros((len(self.detections), 5, 2), dtype=np.float32)


class Recognition:
    def get(self, image, face):
        face.embedding = np.ones(512, dtype=np.float32)


class App:
    def __init__(self, detections):
        self.det_model = Detector(detections)
        self.models = {"recognition": Recognition()}


def image_b64(value=128):
    pixels = np.full((240, 320, 3), value, dtype=np.uint8)
    pixels[60:180, 100:220] = ((np.indices((120, 120)).sum(axis=0) % 2) * 100 + 80)[:, :, None]
    buf = io.BytesIO()
    Image.fromarray(pixels[:, :, ::-1]).save(buf, format="JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def configured_service(detection):
    service = FaceRecognitionService()
    service._available = True
    service._app = App([detection])
    record = FaceEmbeddingRecord("template", "employee", "Pessoa", np.ones(512, dtype=np.float32))
    service._flat_embeddings = [record]
    service._embedding_matrix_records = [record]
    service._embedding_matrix = np.ones((1, 512), dtype=np.float32)
    return service


def test_frame_telemetry_has_no_image_and_contains_timings():
    result = configured_service([100, 60, 220, 180, 0.95]).identify_fast(image_b64())
    telemetry = result.pop("_telemetry")
    assert telemetry["quality_pass"] is True
    assert telemetry["frame_decision"] == "approved"
    assert telemetry["face_count"] == 1
    assert telemetry["detection_embedding_ms"] >= 0
    assert telemetry["comparison_ms"] >= 0
    assert telemetry["backend_total_ms"] >= telemetry["comparison_ms"]
    assert "image" not in telemetry
    assert "base64" not in telemetry


def test_bad_frame_telemetry_records_rejection_without_image():
    result = configured_service([100, 60, 220, 180, 0.95]).identify_fast(image_b64(0))
    telemetry = result.pop("_telemetry")
    assert result["status"] == "retry"
    assert telemetry["quality_pass"] is False
    assert telemetry["rejection_reason"]
    assert telemetry["face_count"] == 1
    assert "image" not in telemetry
    assert "base64" not in telemetry


def test_friendly_messages_do_not_expose_scores():
    from server import friendly_facial_message

    result = {
        "status": "retry",
        "message": "Reconhecimento facial não confirmado. Posicione-se novamente.",
        "similarity_score": 0.91,
        "candidate_margin": 0.6,
    }
    message = friendly_facial_message(result)
    assert "0.91" not in message
    assert "0.6" not in message
    assert "score" not in message.lower()
