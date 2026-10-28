from __future__ import annotations

import base64
import io
import logging
import os
import threading
import time
from datetime import datetime, timezone
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import numpy as np
from PIL import Image, ImageFilter, ImageOps

logger = logging.getLogger(__name__)

try:
    import onnxruntime as ort
except Exception:  # pragma: no cover - dependency may be unavailable in local dev
    ort = None

try:
    from insightface.app import FaceAnalysis
    from insightface.app.common import Face
except Exception:  # pragma: no cover - dependency may be unavailable in local dev
    FaceAnalysis = None


SIMILARITY_AUTO_APPROVE = 0.80
SIMILARITY_RETRY_MIN = 0.70
MIN_CANDIDATE_MARGIN = 0.04
MIN_DETECTION_SCORE = 0.55
MIN_BRIGHTNESS = 45
MIN_SHARPNESS = 9
MIN_FACE_RATIO = 0.025
MAX_FACE_RATIO = 0.65
MAX_CENTER_OFFSET = 0.34
CENTRAL_REGION = {"left": 0.22, "top": 0.12, "right": 0.78, "bottom": 0.86}
MIN_FACE_BOX_CONTAINMENT = 0.80
MIN_FACE_BRIGHTNESS_PRECHECK = 35.0
MAX_FACE_BRIGHTNESS_PRECHECK = 245.0
MIN_FACE_SHARPNESS_PRECHECK = 6.0
MAX_FACE_DARK_RATIO_PRECHECK = 0.65
MAX_FACE_BRIGHT_RATIO_PRECHECK = 0.65
MAX_FACE_SATURATION_RATIO_PRECHECK = 0.50
RECOGNITION_NOT_CONFIRMED = "Reconhecimento facial não confirmado. Posicione-se novamente diante da câmera."


@dataclass
class FaceEmbeddingRecord:
    template_id: str
    employee_id: str
    employee_name: str
    descriptor: np.ndarray
    pose_label: str = "frontal"
    quality_score: float = 0.0
    detection_score: float = 0.0
    employee: Optional[Dict[str, Any]] = None


@dataclass(frozen=True)
class FaceCacheSnapshot:
    generation: int
    flat_embeddings: tuple
    by_employee: Dict[str, tuple]
    matrix_records: tuple
    embedding_matrix: Optional[np.ndarray]


class FaceRecognitionService:
    def __init__(self) -> None:
        self._app: Optional[Any] = None
        self._available = False
        self._flat_embeddings: List[FaceEmbeddingRecord] = []
        self._by_employee: Dict[str, List[FaceEmbeddingRecord]] = {}
        self._embedding_matrix: Optional[np.ndarray] = None
        self._embedding_matrix_records: List[FaceEmbeddingRecord] = []
        self._cache_lock = threading.RLock()
        self._cache_generation = 0
        self._cache_snapshot: Optional[FaceCacheSnapshot] = None
        self._cache_stats = {
            "received_embeddings": 0,
            "valid_embeddings": 0,
            "invalid_embeddings": 0,
            "distinct_identities": 0,
            "generation": 0,
            "last_reload_status": "not_loaded",
            "last_reload_at": None,
        }
        self._onnx_providers = ["CPUExecutionProvider"]
        self._thread_options = {
            "intra_op_num_threads": int(os.environ.get("FACE_ORT_INTRA_THREADS", "4")),
            "inter_op_num_threads": int(os.environ.get("FACE_ORT_INTER_THREADS", "2")),
        }

    @property
    def available(self) -> bool:
        return self._available

    @property
    def cache_size(self) -> int:
        return len(self._flat_embeddings)

    @property
    def cached_employee_count(self) -> int:
        return len(self._by_employee)

    def initialize_runtime(self) -> None:
        if self._app is not None:
            return

        if FaceAnalysis is None or ort is None:
            logger.warning("InsightFace/onnxruntime indisponiveis; reconhecimento facial backend desativado.")
            self._available = False
            return

        try:
            sess_options = ort.SessionOptions()
            sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
            sess_options.intra_op_num_threads = self._thread_options["intra_op_num_threads"]
            sess_options.inter_op_num_threads = self._thread_options["inter_op_num_threads"]

            self._app = FaceAnalysis(
                name=os.environ.get("INSIGHTFACE_MODEL_NAME", "buffalo_l"),
                providers=self._onnx_providers,
                allowed_modules=["detection", "recognition"],
                session_options=sess_options,
            )
            det_size = int(os.environ.get("INSIGHTFACE_DET_SIZE", "640"))
            self._app.prepare(ctx_id=0, det_size=(det_size, det_size))
            self._available = True
            logger.info("InsightFace inicializado com provider CPUExecutionProvider.")
        except Exception as error:  # pragma: no cover - runtime-specific
            logger.exception("Falha ao inicializar InsightFace: %s", error)
            self._app = None
            self._available = False

    async def initialize_cache(self, db: Any) -> None:
        self.initialize_runtime()
        await self.reload_cache(db)

    async def reload_cache(self, db: Any) -> None:
        templates = await db.facial_templates.find({}).to_list(5000)
        invalid_embeddings = 0
        employee_ids = []
        for template in templates:
            employee_id = template.get("employee_id")
            if employee_id:
                employee_ids.append(employee_id)

        employees = await db.employees.find({"_id": {"$in": list(set(employee_ids))}}).to_list(5000)
        employee_map = {str(employee["_id"]): employee for employee in employees}

        flat_embeddings: List[FaceEmbeddingRecord] = []
        by_employee: Dict[str, List[FaceEmbeddingRecord]] = {}

        for template in templates:
            try:
                descriptor = np.asarray(self._parse_descriptor(template.get("descriptor")), dtype=np.float32)
                if descriptor.size != 512:
                    invalid_embeddings += 1
                    logger.info("Template facial legado ignorado por dimensao incompatível: %s", descriptor.size)
                    continue
                employee_id = str(template.get("employee_id") or "").strip()
                if not employee_id:
                    invalid_embeddings += 1
                    continue
                employee = employee_map.get(employee_id)
                if employee is None:
                    invalid_embeddings += 1
                    continue

                record = FaceEmbeddingRecord(
                    template_id=str(template["_id"]),
                    employee_id=employee_id,
                    employee_name=employee.get("full_name", "Desconhecido"),
                    descriptor=descriptor,
                    pose_label=template.get("pose_label") or "frontal",
                    quality_score=float(template.get("quality_score") or 0.0),
                    detection_score=float(template.get("detection_score") or 0.0),
                    employee=employee,
                )
                flat_embeddings.append(record)
                by_employee.setdefault(employee_id, []).append(record)
            except Exception as error:
                invalid_embeddings += 1
                logger.warning("Template facial ignorado no cache: %s", error)

        matrix_records = []
        matrix_rows = []
        for record in flat_embeddings:
            descriptor = np.asarray(record.descriptor, dtype=np.float32).reshape(-1)
            norm = float(np.linalg.norm(descriptor))
            if norm > 0:
                matrix_records.append(record)
                matrix_rows.append(descriptor / norm)
        embedding_matrix = (
            np.vstack(matrix_rows).astype(np.float32, copy=False)
            if matrix_rows else None
        )
        if embedding_matrix is not None and embedding_matrix.shape != (len(matrix_records), 512):
            raise ValueError("Cache facial inconsistente: matriz e registros incompatíveis")

        snapshot_by_employee = {
            employee_id: tuple(records)
            for employee_id, records in by_employee.items()
        }
        with self._cache_lock:
            snapshot = FaceCacheSnapshot(
                generation=self._cache_generation + 1,
                flat_embeddings=tuple(flat_embeddings),
                by_employee=snapshot_by_employee,
                matrix_records=tuple(matrix_records),
                embedding_matrix=embedding_matrix,
            )
            self._cache_snapshot = snapshot
            self._cache_generation = snapshot.generation
            self._flat_embeddings = list(snapshot.flat_embeddings)
            self._by_employee = {
                employee_id: list(records)
                for employee_id, records in snapshot.by_employee.items()
            }
            self._embedding_matrix_records = list(snapshot.matrix_records)
            self._embedding_matrix = snapshot.embedding_matrix
            self._cache_stats = {
                "received_embeddings": len(templates),
                "valid_embeddings": len(matrix_records),
                "invalid_embeddings": invalid_embeddings,
                "distinct_identities": len(snapshot.by_employee),
                "generation": snapshot.generation,
                "last_reload_status": "ok",
                "last_reload_at": datetime.now(timezone.utc).isoformat(),
            }
        logger.info("Cache facial carregado com %s embeddings de %s colaboradores.", len(flat_embeddings), len(by_employee))

    def _get_cache_snapshot(self) -> Optional[FaceCacheSnapshot]:
        with self._cache_lock:
            return self._cache_snapshot

    def cache_diagnostics(self) -> Dict[str, Any]:
        """Return sanitized cache state for an authenticated administrative caller."""
        with self._cache_lock:
            return dict(self._cache_stats)

    def build_temporary_gallery(
        self, galleries: Dict[str, List[np.ndarray]]
    ) -> FaceCacheSnapshot:
        """Build an isolated gallery without touching the production snapshot."""
        records: List[FaceEmbeddingRecord] = []
        by_employee: Dict[str, List[FaceEmbeddingRecord]] = {}
        matrix_rows = []
        matrix_records = []
        for subject, embeddings in galleries.items():
            if not subject or not isinstance(embeddings, list):
                raise ValueError("Galeria temporaria invalida")
            for index, embedding in enumerate(embeddings):
                descriptor = np.asarray(embedding, dtype=np.float32).reshape(-1)
                if descriptor.size != 512 or not np.isfinite(descriptor).all():
                    raise ValueError("Embedding temporario incompatível com buffalo_l")
                norm = float(np.linalg.norm(descriptor))
                if norm <= 0:
                    raise ValueError("Embedding temporario sem norma valida")
                record = FaceEmbeddingRecord(
                    template_id=f"phase103-{subject}-reference-{index}",
                    employee_id=subject,
                    employee_name=subject,
                    descriptor=descriptor.copy(),
                )
                records.append(record)
                by_employee.setdefault(subject, []).append(record)
                matrix_records.append(record)
                matrix_rows.append(descriptor / norm)
        if not matrix_rows:
            raise ValueError("Galeria temporaria vazia")
        matrix = np.vstack(matrix_rows).astype(np.float32, copy=False)
        if matrix.shape != (len(matrix_records), 512):
            raise ValueError("Galeria temporaria inconsistente")
        return FaceCacheSnapshot(
            generation=0,
            flat_embeddings=tuple(records),
            by_employee={key: tuple(value) for key, value in by_employee.items()},
            matrix_records=tuple(matrix_records),
            embedding_matrix=matrix,
        )

    def rank_candidates_in_gallery(
        self, probe: np.ndarray, gallery: FaceCacheSnapshot
    ) -> List[Dict[str, Any]]:
        """Rank only against the explicitly supplied temporary gallery."""
        return self._rank_candidates_from_snapshot(probe, gallery)

    async def refresh_employee_cache(self, db: Any, employee_id: str) -> None:
        await self.reload_cache(db)

    def _parse_descriptor(self, raw_descriptor: Any) -> List[float]:
        if isinstance(raw_descriptor, str):
            import json

            return json.loads(raw_descriptor)
        return list(raw_descriptor or [])

    def descriptor_dimension(self, raw_descriptor: Any) -> int:
        try:
            return len(self._parse_descriptor(raw_descriptor))
        except Exception:
            return 0

    def is_descriptor_compatible(self, raw_descriptor: Any) -> bool:
        return self.descriptor_dimension(raw_descriptor) >= 256

    async def get_migration_status(self, db: Any) -> Dict[str, Any]:
        templates = await db.facial_templates.find({}).to_list(5000)
        employee_ids = []
        for template in templates:
            employee_id = template.get("employee_id")
            if employee_id:
                employee_ids.append(employee_id)

        employees = await db.employees.find({"_id": {"$in": list(set(employee_ids))}}).to_list(5000)
        employee_map = {str(employee["_id"]): employee for employee in employees}

        summary: Dict[str, Dict[str, Any]] = {}
        compatible_templates = 0
        legacy_templates = 0

        for template in templates:
            employee_id = str(template.get("employee_id"))
            employee = employee_map.get(employee_id)
            if employee is None:
                continue

            item = summary.setdefault(
                employee_id,
                {
                    "employee_id": employee_id,
                    "employee_name": employee.get("full_name", "Desconhecido"),
                    "total_templates": 0,
                    "compatible_templates": 0,
                    "legacy_templates": 0,
                    "needs_reenrollment": False,
                },
            )
            item["total_templates"] += 1

            if self.is_descriptor_compatible(template.get("descriptor")):
                item["compatible_templates"] += 1
                compatible_templates += 1
            else:
                item["legacy_templates"] += 1
                item["needs_reenrollment"] = True
                legacy_templates += 1

        employees_list = sorted(summary.values(), key=lambda item: item["employee_name"].lower())
        employees_ready = sum(1 for item in employees_list if item["compatible_templates"] > 0)
        employees_needing_reenrollment = sum(1 for item in employees_list if item["needs_reenrollment"] or item["compatible_templates"] == 0)

        return {
            "service_available": self.available,
            "cache_size": self.cache_size,
            "total_templates": len(templates),
            "compatible_templates": compatible_templates,
            "legacy_templates": legacy_templates,
            "employees_with_templates": len(employees_list),
            "employees_ready": employees_ready,
            "employees_needing_reenrollment": employees_needing_reenrollment,
            "employees": employees_list,
        }

    def decode_base64_image(self, image_base64: str) -> np.ndarray:
        if "," in image_base64:
            image_base64 = image_base64.split(",", 1)[1]

        image_bytes = base64.b64decode(image_base64)
        pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        return np.asarray(pil_image)[:, :, ::-1]

    def _brightness_and_sharpness(self, image_bgr: np.ndarray) -> Dict[str, float]:
        pil_gray = ImageOps.grayscale(Image.fromarray(image_bgr[:, :, ::-1]))
        brightness = float(np.asarray(pil_gray).mean())
        sharpness = float(np.asarray(pil_gray.filter(ImageFilter.FIND_EDGES)).mean())
        return {"brightness": brightness, "sharpness": sharpness}

    def _face_geometry(self, face: Any, image_bgr: np.ndarray) -> Dict[str, Any]:
        bbox = np.asarray(face.bbox, dtype=np.float32)
        width = float(image_bgr.shape[1])
        height = float(image_bgr.shape[0])
        face_width = max(float(bbox[2] - bbox[0]), 1.0)
        face_height = max(float(bbox[3] - bbox[1]), 1.0)
        face_ratio = (face_width * face_height) / (width * height)
        center_x = (bbox[0] + bbox[2]) / 2.0
        center_y = (bbox[1] + bbox[3]) / 2.0
        offset_x = abs(center_x - (width / 2.0)) / width
        offset_y = abs(center_y - (height / 2.0)) / height
        in_central_region = (
            center_x >= width * CENTRAL_REGION["left"]
            and center_x <= width * CENTRAL_REGION["right"]
            and center_y >= height * CENTRAL_REGION["top"]
            and center_y <= height * CENTRAL_REGION["bottom"]
        )
        region_left = width * CENTRAL_REGION["left"]
        region_top = height * CENTRAL_REGION["top"]
        region_right = width * CENTRAL_REGION["right"]
        region_bottom = height * CENTRAL_REGION["bottom"]
        intersection_width = max(0.0, min(float(bbox[2]), region_right) - max(float(bbox[0]), region_left))
        intersection_height = max(0.0, min(float(bbox[3]), region_bottom) - max(float(bbox[1]), region_top))
        bbox_area = face_width * face_height
        containment_ratio = (intersection_width * intersection_height) / bbox_area
        return {
            "bbox": bbox,
            "width": width,
            "height": height,
            "face_ratio": face_ratio,
            "center_x": center_x,
            "center_y": center_y,
            "offset_x": offset_x,
            "offset_y": offset_y,
            "in_central_region": in_central_region,
            "containment_ratio": containment_ratio,
            "predominantly_contained": containment_ratio >= MIN_FACE_BOX_CONTAINMENT,
        }

    def _face_quality_metrics(self, image_bgr: np.ndarray, bbox: Any) -> Dict[str, Any]:
        box = np.asarray(bbox, dtype=np.int32).reshape(-1)
        left = max(0, min(int(box[0]), image_bgr.shape[1] - 1))
        top = max(0, min(int(box[1]), image_bgr.shape[0] - 1))
        right = max(left + 1, min(int(box[2]), image_bgr.shape[1]))
        bottom = max(top + 1, min(int(box[3]), image_bgr.shape[0]))
        face_crop = image_bgr[top:bottom, left:right]
        gray = np.asarray(ImageOps.grayscale(Image.fromarray(face_crop[:, :, ::-1])))
        mean_luma = float(gray.mean())
        sharpness = float(np.asarray(Image.fromarray(gray).filter(ImageFilter.FIND_EDGES)).mean())
        dark_ratio = float((gray < 35).mean())
        bright_ratio = float((gray > 245).mean())
        saturated_ratio = float(((face_crop.max(axis=2) >= 250) & (face_crop.min(axis=2) >= 245)).mean())
        usable = (
            mean_luma >= MIN_FACE_BRIGHTNESS_PRECHECK
            and mean_luma <= MAX_FACE_BRIGHTNESS_PRECHECK
            and sharpness >= MIN_FACE_SHARPNESS_PRECHECK
            and dark_ratio <= MAX_FACE_DARK_RATIO_PRECHECK
            and bright_ratio <= MAX_FACE_BRIGHT_RATIO_PRECHECK
            and saturated_ratio <= MAX_FACE_SATURATION_RATIO_PRECHECK
        )
        return {
            "face_brightness": mean_luma,
            "face_sharpness": sharpness,
            "face_dark_ratio": dark_ratio,
            "face_bright_ratio": bright_ratio,
            "face_saturated_ratio": saturated_ratio,
            "face_quality_usable": usable,
        }

    def _single_face_or_reason(
        self,
        image_bgr: np.ndarray,
        enforce_global_sharpness: bool = True,
    ) -> Dict[str, Any]:
        if not self._available or self._app is None:
            return {"status": "blocked", "message": "Servico facial backend indisponivel."}

        bboxes, kpss = self._app.det_model.detect(image_bgr, max_num=0, metric="default")
        if bboxes is None or len(bboxes) == 0:
            return {"status": "retry", "message": "Nenhum rosto detectado. Centralize o colaborador na camera."}

        faces = []
        relevant_faces = []
        for index, detection in enumerate(bboxes):
            face = Face(
                bbox=np.asarray(detection[0:4], dtype=np.float32),
                kps=kpss[index] if kpss is not None and len(kpss) > index else None,
                det_score=float(detection[4]),
            )
            faces.append(face)
            geometry = self._face_geometry(face, image_bgr)
            if (
                geometry["in_central_region"]
                and geometry["predominantly_contained"]
                and geometry["face_ratio"] >= MIN_FACE_RATIO
                and float(face.det_score) >= MIN_DETECTION_SCORE
            ):
                relevant_faces.append((face, geometry))

        if len(relevant_faces) > 1:
            return {
                "status": "blocked",
                "message": "Mais de uma pessoa detectada. Mantenha somente uma pessoa em frente a camera.",
                "face_count": len(faces),
                "relevant_face_count": len(relevant_faces),
            }

        if len(relevant_faces) == 1:
            face, geometry = relevant_faces[0]
        else:
            faces_sorted = sorted(
                ((candidate, self._face_geometry(candidate, image_bgr)) for candidate in faces),
                key=lambda item: item[1]["face_ratio"],
                reverse=True,
            )
            face, geometry = faces_sorted[0]

        det_score = float(getattr(face, "det_score", 0.0))
        face_ratio = geometry["face_ratio"]
        offset_x = geometry["offset_x"]
        offset_y = geometry["offset_y"]
        common = {
            "face_count": len(faces),
            "relevant_face_count": len(relevant_faces),
            "image_width": int(image_bgr.shape[1]),
            "image_height": int(image_bgr.shape[0]),
            "face_width": round(float(geometry["bbox"][2] - geometry["bbox"][0]), 2),
            "face_height": round(float(geometry["bbox"][3] - geometry["bbox"][1]), 2),
            "detection_score": det_score,
            "face_ratio": face_ratio,
            "center_offset_x": offset_x,
            "center_offset_y": offset_y,
            "containment_ratio": geometry["containment_ratio"],
        }
        if det_score < MIN_DETECTION_SCORE:
            return {"status": "retry", "message": "Rosto detectado com baixa confianca. Melhore a iluminacao.", **common}
        if not geometry["in_central_region"] or not geometry["predominantly_contained"]:
            return {"status": "retry", "message": "Centralize o rosto do colaborador na imagem.", **common}
        if face_ratio < MIN_FACE_RATIO:
            return {"status": "retry", "message": "Rosto muito distante. Aproxime o celular ou o colaborador da camera.", **common}
        if face_ratio > MAX_FACE_RATIO:
            return {"status": "retry", "message": "Rosto muito proximo. Afaste um pouco a camera.", **common}
        if offset_x > MAX_CENTER_OFFSET or offset_y > MAX_CENTER_OFFSET:
            return {"status": "retry", "message": "Centralize o rosto do colaborador na imagem.", **common}

        face_metrics = self._face_quality_metrics(image_bgr, geometry["bbox"])
        image_metrics = self._brightness_and_sharpness(image_bgr)
        if not face_metrics["face_quality_usable"]:
            return {
                "status": "retry",
                "message": "Qualidade da imagem insuficiente. Melhore a iluminacao e mantenha o rosto nitido.",
                **common,
                **face_metrics,
            }

        if image_metrics["brightness"] < MIN_BRIGHTNESS:
            return {"status": "retry", "message": "Imagem escura. Melhore a iluminacao antes de continuar.", **common, **face_metrics, **image_metrics}
        if enforce_global_sharpness and image_metrics["sharpness"] < MIN_SHARPNESS:
            return {"status": "retry", "message": "Imagem desfocada. Posicione-se novamente.", **common, **face_metrics, **image_metrics}

        recognition_model = self._app.models.get("recognition")
        if recognition_model is None:
            return {"status": "blocked", "message": "Modelo de reconhecimento facial indisponivel.", **common, **face_metrics}
        recognition_model.get(image_bgr, face)
        embedding = np.asarray(getattr(face, "embedding", None), dtype=np.float32)
        if embedding.size == 0:
            return {"status": "retry", "message": "Nao foi possivel gerar embedding facial. Tente novamente.", **common, **face_metrics}

        return {
            "status": "ok",
            "face": face,
            "embedding": embedding,
            **common,
            **face_metrics,
            **image_metrics,
        }

    def evaluate_image(self, image_base64: str) -> Dict[str, Any]:
        image_bgr = self.decode_base64_image(image_base64)
        return self._single_face_or_reason(image_bgr)

    def enroll_from_image(self, image_base64: str, pose_label: str = "frontal") -> Dict[str, Any]:
        attempt_id = str(uuid.uuid4())
        started_at = time.perf_counter()
        image_bgr = self.decode_base64_image(image_base64)
        evaluation = self._single_face_or_reason(image_bgr, enforce_global_sharpness=False)
        telemetry = {
            "attempt_id": attempt_id,
            "image_width": evaluation.get("image_width", int(image_bgr.shape[1])),
            "image_height": evaluation.get("image_height", int(image_bgr.shape[0])),
            "face_width": evaluation.get("face_width"),
            "face_height": evaluation.get("face_height"),
            "face_sharpness": evaluation.get("face_sharpness"),
            "global_sharpness": evaluation.get("sharpness"),
            "face_brightness": evaluation.get("face_brightness"),
            "detection_score": evaluation.get("detection_score"),
            "containment_ratio": evaluation.get("containment_ratio"),
            "status": evaluation.get("status"),
            "reason": evaluation.get("message"),
            "processing_ms": round((time.perf_counter() - started_at) * 1000, 3),
        }
        logger.info("Cadastro facial avaliado: %s", telemetry)
        if evaluation["status"] != "ok":
            return evaluation

        quality_score = self._compute_quality_score(
            detection_score=evaluation["detection_score"],
            brightness=evaluation["brightness"],
            sharpness=evaluation["sharpness"],
        )
        return {
            "status": "ok",
            "embedding": evaluation["embedding"],
            "detection_score": evaluation["detection_score"],
            "quality_score": quality_score,
            "pose_label": pose_label,
            "message": "Biometria facial pronta para cadastro.",
        }

    def _compute_quality_score(self, detection_score: float, brightness: float, sharpness: float) -> float:
        brightness_score = float(np.clip(brightness / 120.0, 0.0, 1.0))
        sharpness_score = float(np.clip(sharpness / 40.0, 0.0, 1.0))
        return round((detection_score * 0.5) + (brightness_score * 0.2) + (sharpness_score * 0.3), 4)

    def _quality_snapshot(self, evaluation: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        keys = (
            "brightness", "sharpness", "detection_score", "face_count",
            "relevant_face_count", "face_ratio", "center_offset_x",
            "center_offset_y", "containment_ratio", "face_brightness",
            "face_sharpness", "face_dark_ratio", "face_bright_ratio",
            "face_saturated_ratio",
        )
        snapshot = {key: evaluation[key] for key in keys if key in evaluation}
        return snapshot or None

    def _finish_frame_result(
        self,
        result: Dict[str, Any],
        evaluation: Dict[str, Any],
        started_at: float,
        evaluation_ms: float,
        comparison_ms: float,
    ) -> Dict[str, Any]:
        quality = result.get("quality") or self._quality_snapshot(evaluation)
        result.setdefault("quality", quality)
        result["_telemetry"] = {
            "detected": bool(evaluation.get("face_count")),
            "face_count": int(evaluation.get("face_count") or 0),
            "relevant_face_count": int(evaluation.get("relevant_face_count") or 0),
            "quality_pass": evaluation.get("status") == "ok",
            "rejection_reason": None if result.get("status") == "approved" else result.get("message"),
            "face_sharpness": evaluation.get("face_sharpness"),
            "face_brightness": evaluation.get("face_brightness"),
            "face_saturated_ratio": evaluation.get("face_saturated_ratio"),
            "face_ratio": evaluation.get("face_ratio"),
            "containment_ratio": evaluation.get("containment_ratio"),
            "similarity_score": result.get("similarity_score"),
            "candidate_employee_id": result.get("candidate_employee_id"),
            "second_similarity_score": result.get("second_similarity_score"),
            "second_candidate_employee_id": result.get("second_candidate_employee_id"),
            "candidate_margin": result.get("candidate_margin"),
            "frame_decision": result.get("status"),
            "detection_embedding_ms": round(float(evaluation_ms), 3),
            "comparison_ms": round(float(comparison_ms), 3),
            "backend_total_ms": round((time.perf_counter() - started_at) * 1000, 3),
        }
        return result

    def identify_fast(self, image_base64: str) -> Dict[str, Any]:
        started_at = time.perf_counter()
        evaluation_started = time.perf_counter()
        evaluation = self.evaluate_image(image_base64)
        evaluation_ms = (time.perf_counter() - evaluation_started) * 1000
        if evaluation["status"] != "ok":
            return self._finish_frame_result({
                "status": evaluation["status"],
                "message": evaluation["message"],
                "employee_id": None,
                "employee_name": None,
                "similarity_score": 0.0,
                "detection_confidence": float(evaluation.get("detection_score") or 0.0),
                "liveness_required": False,
            }, evaluation, started_at, evaluation_ms, 0.0)

        probe = np.asarray(evaluation.get("embedding"), dtype=np.float32).reshape(-1)
        if probe.size != 512 or not np.isfinite(probe).all() or float(np.linalg.norm(probe)) <= 0:
            return self._finish_frame_result({
                "status": "embedding_invalid",
                "message": "Embedding facial invalido para esta tentativa.",
                "employee_id": None,
                "employee_name": None,
                "similarity_score": 0.0,
                "detection_confidence": float(evaluation.get("detection_score") or 0.0),
                "liveness_required": False,
            }, evaluation, started_at, evaluation_ms, 0.0)

        snapshot = self._get_cache_snapshot()
        if snapshot is None or not snapshot.flat_embeddings:
            return self._finish_frame_result({
                "status": "cache_unavailable",
                "message": "Nenhuma biometria facial cadastrada na base.",
                "employee_id": None,
                "employee_name": None,
                "similarity_score": 0.0,
                "detection_confidence": evaluation["detection_score"],
                "liveness_required": False,
            }, evaluation, started_at, evaluation_ms, 0.0)

        comparison_started = time.perf_counter()
        if snapshot.embedding_matrix is None or not snapshot.matrix_records:
            return self._finish_frame_result({
                "status": "cache_inconsistent",
                "message": "Cache facial indisponivel para esta tentativa.",
                "employee_id": None,
                "employee_name": None,
                "similarity_score": 0.0,
                "detection_confidence": evaluation["detection_score"],
                "liveness_required": False,
            }, evaluation, started_at, evaluation_ms, 0.0)
        ranked = self._rank_candidates_from_snapshot(probe, snapshot)
        comparison_ms = (time.perf_counter() - comparison_started) * 1000
        best = ranked[0] if ranked else None
        second = next(
            (item for item in ranked[1:] if item["record"].employee_id != best["record"].employee_id),
            None,
        ) if best else None
        best_record = best["record"] if best else None
        best_similarity = best["similarity"] if best else -1.0
        second_similarity = second["similarity"] if second else None
        margin = best_similarity - second_similarity if second else None

        if best_record is None:
            return self._finish_frame_result({
                "status": "blocked",
                "message": "Nenhum colaborador identificado.",
                "employee_id": None,
                "employee_name": None,
                "similarity_score": 0.0,
                "detection_confidence": evaluation["detection_score"],
                "liveness_required": False,
            }, evaluation, started_at, evaluation_ms, comparison_ms)

        if best_similarity < SIMILARITY_AUTO_APPROVE:
            status = "score_below_threshold"
            message = RECOGNITION_NOT_CONFIRMED
        elif second is None:
            status = "second_candidate_unavailable"
            message = "Segundo candidato indisponivel para confirmar a margem."
        elif margin < MIN_CANDIDATE_MARGIN:
            status = "margin_below_threshold"
            message = RECOGNITION_NOT_CONFIRMED
        else:
            status = "approved"
            message = f"{best_record.employee_name} identificado."
        liveness_required = False

        result = {
            "status": status,
            "message": message,
            "employee_id": best_record.employee_id if status == "approved" else None,
            "employee_name": best_record.employee_name if status == "approved" else None,
            "similarity_score": round(float(best_similarity), 4),
            "detection_confidence": round(float(evaluation["detection_score"]), 4),
            "liveness_required": liveness_required,
            "matched_pose_label": best_record.pose_label,
            "matched_template_id": best_record.template_id,
            "candidate_employee_id": best_record.employee_id,
            "candidate_employee_name": best_record.employee_name,
            "second_candidate_employee_id": second["record"].employee_id if second else None,
            "second_candidate_employee_name": second["record"].employee_name if second else None,
            "second_similarity_score": round(float(second_similarity), 4) if second_similarity is not None else None,
            "candidate_margin": round(float(margin), 4) if margin is not None else None,
            "min_required_margin": MIN_CANDIDATE_MARGIN,
            "quality": {
                "brightness": round(float(evaluation.get("brightness") or 0.0), 4),
                "sharpness": round(float(evaluation.get("sharpness") or 0.0), 4),
                "detection_score": round(float(evaluation.get("detection_score") or 0.0), 4),
                "face_count": int(evaluation.get("face_count") or 0),
                "relevant_face_count": int(evaluation.get("relevant_face_count") or 0),
                "face_ratio": round(float(evaluation.get("face_ratio") or 0.0), 6),
                "center_offset_x": round(float(evaluation.get("center_offset_x") or 0.0), 6),
                "center_offset_y": round(float(evaluation.get("center_offset_y") or 0.0), 6),
                "containment_ratio": round(float(evaluation.get("containment_ratio") or 0.0), 6),
                "face_brightness": round(float(evaluation.get("face_brightness") or 0.0), 4),
                "face_sharpness": round(float(evaluation.get("face_sharpness") or 0.0), 4),
                "face_dark_ratio": round(float(evaluation.get("face_dark_ratio") or 0.0), 4),
                "face_bright_ratio": round(float(evaluation.get("face_bright_ratio") or 0.0), 4),
                "face_saturated_ratio": round(float(evaluation.get("face_saturated_ratio") or 0.0), 4),
            },
            "decision_rule": "cosine_similarity_threshold_and_margin",
        }
        return self._finish_frame_result(result, evaluation, started_at, evaluation_ms, comparison_ms)

    def _rank_candidates(self, probe: np.ndarray) -> List[Dict[str, Any]]:
        snapshot = self._get_cache_snapshot()
        if snapshot is None:
            return []
        return self._rank_candidates_from_snapshot(probe, snapshot)

    def _rank_candidates_from_snapshot(
        self, probe: np.ndarray, snapshot: FaceCacheSnapshot
    ) -> List[Dict[str, Any]]:
        probe_array = np.asarray(probe, dtype=np.float32).reshape(-1)
        probe_norm = float(np.linalg.norm(probe_array))
        matrix = snapshot.embedding_matrix
        records = snapshot.matrix_records
        if matrix is not None and probe_norm > 0 and matrix.shape[1] == probe_array.size:
            similarities = np.clip(matrix @ (probe_array / probe_norm), 0.0, 1.0)
            order = np.argsort(-similarities, kind="stable")
            return [
                {"record": records[index], "similarity": float(similarities[index])}
                for index in order
            ]
        ranked = [
            {"record": record, "similarity": self._cosine_similarity(probe_array, record.descriptor)}
            for record in snapshot.flat_embeddings
        ]
        ranked.sort(key=lambda item: item["similarity"], reverse=True)
        return ranked

    def _cosine_similarity(self, probe: np.ndarray, gallery: np.ndarray) -> float:
        if probe.shape != gallery.shape:
            return 0.0
        probe_norm = np.linalg.norm(probe)
        gallery_norm = np.linalg.norm(gallery)
        if probe_norm == 0 or gallery_norm == 0:
            return 0.0
        similarity = float(np.dot(probe, gallery) / (probe_norm * gallery_norm))
        return max(0.0, min(1.0, similarity))

    def liveness_check(self, image_base64: str, previous_image_base64: Optional[str] = None) -> Dict[str, Any]:
        current_eval = self.evaluate_image(image_base64)
        if current_eval["status"] != "ok":
            return {
                "status": "retry",
                "message": current_eval["message"],
                "passed": False,
            }

        if not previous_image_base64:
            return {
                "status": "retry",
                "message": "Envie uma segunda captura para validar movimento ou piscada.",
                "passed": False,
            }

        previous_eval = self.evaluate_image(previous_image_base64)
        if previous_eval["status"] != "ok":
            return {
                "status": "retry",
                "message": "A segunda captura nao ficou valida. Tente novamente com leve movimento.",
                "passed": False,
            }

        current_bbox = np.asarray(current_eval["bbox"], dtype=np.float32)
        previous_bbox = np.asarray(previous_eval["bbox"], dtype=np.float32)
        delta = np.abs(current_bbox - previous_bbox).mean()
        passed = delta > 4.5

        return {
            "status": "approved" if passed else "retry",
            "message": "Movimento facial validado." if passed else "Movimento insuficiente. Pisque ou mova levemente o rosto.",
            "passed": passed,
            "movement_delta": round(float(delta), 4),
        }
