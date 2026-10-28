import numpy as np

from backend.services.face_recognition_service import FaceEmbeddingRecord, FaceRecognitionService


class FakeDetector:
    def __init__(self, detections):
        self.detections = detections

    def detect(self, image, max_num=0, metric="default"):
        keypoints = np.zeros((len(self.detections), 5, 2), dtype=np.float32)
        return np.asarray(self.detections, dtype=np.float32), keypoints


class FakeRecognition:
    def __init__(self):
        self.calls = 0

    def get(self, image, face):
        self.calls += 1
        face.embedding = np.ones(512, dtype=np.float32)


class FakeApp:
    def __init__(self, detections):
        self.det_model = FakeDetector(detections)
        self.recognition = FakeRecognition()
        self.models = {"recognition": self.recognition}


def service_for(detection):
    service = FaceRecognitionService()
    service._available = True
    service._app = FakeApp([detection])
    return service


def textured_image(value=128):
    image = np.full((240, 320, 3), value, dtype=np.uint8)
    image[60:180, 100:220] = ((np.indices((120, 120)).sum(axis=0) % 2) * 100 + 80)[:, :, None]
    return image


def test_face_quality_is_checked_before_recognition_for_dark_frame():
    service = service_for([100, 60, 220, 180, 0.95])
    result = service._single_face_or_reason(np.zeros((240, 320, 3), dtype=np.uint8))
    assert result["status"] == "retry"
    assert result["face_quality_usable"] is False
    assert service._app.recognition.calls == 0


def test_face_quality_is_checked_before_recognition_for_clipped_frame():
    service = service_for([100, 60, 220, 180, 0.95])
    result = service._single_face_or_reason(np.full((240, 320, 3), 255, dtype=np.uint8))
    assert result["status"] == "retry"
    assert result["face_quality_usable"] is False
    assert service._app.recognition.calls == 0


def test_good_face_recognition_uses_face_region_quality():
    service = service_for([100, 60, 220, 180, 0.95])
    result = service._single_face_or_reason(textured_image())
    assert result["status"] == "ok"
    assert result["face_quality_usable"] is True
    assert service._app.recognition.calls == 1


def test_face_must_be_predominantly_inside_central_region():
    service = service_for([10, 60, 150, 180, 0.95])
    result = service._single_face_or_reason(textured_image())
    assert result["status"] == "retry"
    assert "Centralize" in result["message"]


def test_vectorized_ranking_matches_sequential_cosine_values():
    service = FaceRecognitionService()
    records = [
        FaceEmbeddingRecord(str(i), str(i), f"Pessoa {i}", np.eye(3, dtype=np.float32)[i])
        for i in range(3)
    ]
    service._flat_embeddings = records
    service._embedding_matrix_records = records
    service._embedding_matrix = np.vstack([record.descriptor for record in records])
    probe = np.array([1.0, 0.2, 0.4], dtype=np.float32)
    vectorized = service._rank_candidates(probe)
    sequential = [
        {"record": record, "similarity": service._cosine_similarity(probe, record.descriptor)}
        for record in records
    ]
    sequential.sort(key=lambda item: item["similarity"], reverse=True)
    assert [item["record"].template_id for item in vectorized] == [item["record"].template_id for item in sequential]
    assert np.allclose(
        [item["similarity"] for item in vectorized],
        [item["similarity"] for item in sequential],
        atol=1e-6,
    )


def test_burst_consensus_requires_two_frames_and_rejects_conflict():
    from server import resolve_facial_burst_consensus

    approved_a = {"status": "approved", "employee_id": "a", "similarity_score": 0.91}
    approved_b = {"status": "approved", "employee_id": "b", "similarity_score": 0.93}
    assert resolve_facial_burst_consensus([approved_a])["status"] == "retry"
    assert resolve_facial_burst_consensus([approved_a, dict(approved_a)])["status"] == "approved"
    assert resolve_facial_burst_consensus([approved_a, approved_b])["status"] == "conflict"
