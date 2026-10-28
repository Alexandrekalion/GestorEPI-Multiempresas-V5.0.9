"""Ephemeral, admin-only facial benchmark for Fase 10.3.

This module deliberately does not import the database or the production facial
cache. Reference embeddings live only in memory for one short-lived session.
"""

import base64
import io
import math
import secrets
import threading
import time
from typing import Any, Dict, List, Optional

import numpy as np
from fastapi import HTTPException
from pydantic import BaseModel, Field
from PIL import Image

from services.face_recognition_service import FaceCacheSnapshot, FaceRecognitionService


SESSION_TTL_SECONDS = 15 * 60
MAX_REFERENCE_IMAGES = 5
MAX_TEST_IMAGES = 2
_sessions: Dict[str, Dict[str, Any]] = {}
_session_lock = threading.Lock()
_engine: FaceRecognitionService | None = None


class Phase103SessionRequest(BaseModel):
    consent: bool
    mode: str = Field(default='single', pattern='^(single|cross)$')


class Phase103ReferenceRequest(BaseModel):
    session_id: str = Field(min_length=20, max_length=128)
    image_base64: str = Field(min_length=100, max_length=8_000_000)
    subject: str = Field(default='single', pattern='^(single|subject_a|subject_b)$')
    batch_id: str = Field(min_length=16, max_length=128)


class Phase103CompareRequest(BaseModel):
    session_id: str = Field(min_length=20, max_length=128)
    images_base64: List[str] = Field(min_length=2, max_length=MAX_TEST_IMAGES)
    images_b2_base64: Optional[List[str]] = Field(default=None, min_length=2, max_length=MAX_TEST_IMAGES)
    images_person_b_base64: Optional[List[str]] = Field(default=None, min_length=2, max_length=MAX_TEST_IMAGES)
    images_person_b2_base64: Optional[List[str]] = Field(default=None, min_length=2, max_length=MAX_TEST_IMAGES)
    capture_batch_id: Optional[str] = Field(default=None, min_length=16, max_length=128)
    capture_a_batch_id: Optional[str] = Field(default=None, min_length=16, max_length=128)
    capture_b_batch_id: Optional[str] = Field(default=None, min_length=16, max_length=128)


class Phase103CloseRequest(BaseModel):
    session_id: Optional[str] = Field(default=None, min_length=20, max_length=128)


def _clear_session(session_id: str) -> bool:
    with _session_lock:
        session = _sessions.get(session_id)
    if not session:
        return True
    operation_lock = session.get('operation_lock')
    acquired = operation_lock.acquire(timeout=2) if operation_lock else True
    try:
        if not acquired:
            return False
        with _session_lock:
            session = _sessions.pop(session_id, None)
        if not session:
            return True
        session['embeddings'].clear()
        session.get('subject_a', []).clear()
        session.get('subject_b', []).clear()
        session.get('reference_batch_ids', {}).clear()
        session.get('used_identification_batches', set()).clear()
        _clear_benchmark_engine()
        return True
    finally:
        if operation_lock and acquired:
            operation_lock.release()


def _clear_benchmark_engine() -> None:
    """The benchmark engine owns only the model, never a gallery."""
    return


def _expire_session(session_id: str) -> None:
    _clear_session(session_id)


def _purge_expired() -> None:
    now = time.monotonic()
    with _session_lock:
        expired = [
            session_id for session_id, session in _sessions.items()
            if now - session['created_at'] > SESSION_TTL_SECONDS
        ]
    for session_id in expired:
        _clear_session(session_id)


def _get_engine() -> FaceRecognitionService:
    global _engine
    if _engine is None:
        _engine = FaceRecognitionService()
        _engine.initialize_runtime()
    if not _engine.available:
        raise HTTPException(status_code=503, detail='Modelo facial temporario indisponivel')
    return _engine


def _get_session(session_id: str, owner_id: str) -> Dict[str, Any]:
    _purge_expired()
    with _session_lock:
        session = _sessions.get(session_id)
    if not session or session['owner_id'] != owner_id:
        raise HTTPException(status_code=404, detail='Sessao de benchmark inexistente ou expirada')
    return session


def _decode_rgb(data_url: str) -> Image.Image:
    raw = data_url.split(',', 1)[1] if ',' in data_url else data_url
    try:
        image = Image.open(io.BytesIO(base64.b64decode(raw, validate=True)))
        return image.convert('RGB')
    except Exception as exc:
        raise HTTPException(status_code=400, detail='Imagem de benchmark invalida') from exc


def _encode_jpeg(image: Image.Image, quality: int) -> str:
    output = io.BytesIO()
    image.save(output, format='JPEG', quality=quality, optimize=False)
    encoded = base64.b64encode(output.getvalue()).decode('ascii')
    return f'data:image/jpeg;base64,{encoded}'


def _current_crop_data(image: Image.Image) -> str:
    """Reproduce the current benchmark crop without changing production code."""
    width, height = image.size
    current_crop = image.crop((
        round(width * 0.25), round(height * 0.14),
        round(width * 0.75), round(height * 0.82),
    ))
    current_width = min(420, current_crop.width)
    current_crop = current_crop.resize(
        (current_width, round(current_crop.height * current_width / current_crop.width)),
        Image.Resampling.LANCZOS,
    )
    return _encode_jpeg(current_crop, 82)


def _jpeg_metadata(data_url: str, image: Image.Image, quality: int, source: str) -> Dict[str, Any]:
    raw = data_url.split(',', 1)[1] if ',' in data_url else data_url
    try:
        jpeg_bytes = len(base64.b64decode(raw, validate=True))
    except Exception:
        jpeg_bytes = None
    return {
        'source': source,
        'jpeg_quality': quality,
        'image_width': image.width,
        'image_height': image.height,
        'jpeg_bytes': jpeg_bytes,
    }


def _build_temporary_gallery(
    engine: FaceRecognitionService,
    galleries: Dict[str, List[np.ndarray]],
) -> FaceCacheSnapshot:
    """Build an explicit session-local gallery without touching engine state."""
    return engine.build_temporary_gallery(galleries)


def start_session(owner_id: str, consent: bool, mode: str = 'single') -> Dict[str, Any]:
    if not consent:
        raise HTTPException(status_code=400, detail='A autorizacao temporaria e obrigatoria')
    _purge_expired()
    with _session_lock:
        if _sessions:
            raise HTTPException(status_code=409, detail='Ja existe uma sessao temporaria ativa')
        session_id = secrets.token_urlsafe(32)
        _sessions[session_id] = {
            'owner_id': owner_id,
            'mode': mode if mode in {'single', 'cross'} else 'single',
            'created_at': time.monotonic(),
            'embeddings': [],
            'subject_a': [],
            'subject_b': [],
            'reference_batch_ids': {},
            'used_identification_batches': set(),
            'operation_lock': threading.Lock(),
        }
    timer = threading.Timer(SESSION_TTL_SECONDS, _expire_session, args=(session_id,))
    timer.daemon = True
    timer.start()
    return {'session_id': session_id, 'expires_in_seconds': SESSION_TTL_SECONDS}


def resume_session(owner_id: str) -> Dict[str, Any]:
    """Return the active session only to its authenticated owner."""
    _purge_expired()
    with _session_lock:
        owned = next(
            ((session_id, session) for session_id, session in _sessions.items()
             if session['owner_id'] == owner_id),
            None,
        )
    if not owned:
        raise HTTPException(status_code=404, detail='Nenhuma sessao de benchmark ativa')
    session_id, session = owned
    elapsed = max(0.0, time.monotonic() - session['created_at'])
    return {
        'session_id': session_id,
        'reference_count': len(session['embeddings']),
        'mode': 'cross' if session.get('subject_a') or session.get('subject_b') else session.get('mode', 'single'),
        'subject_a_reference_count': len(session.get('subject_a', [])),
        'subject_b_reference_count': len(session.get('subject_b', [])),
        'reference_batch_ids': dict(session.get('reference_batch_ids', {})),
        'expires_in_seconds': max(0, int(SESSION_TTL_SECONDS - elapsed)),
    }


def _add_reference_impl(owner_id: str, payload: Phase103ReferenceRequest) -> Dict[str, Any]:
    session = _get_session(payload.session_id, owner_id)
    subject = payload.subject
    if subject not in {'single', 'subject_a', 'subject_b'}:
        raise HTTPException(status_code=400, detail='Informe Pessoa A ou Pessoa B')
    gallery = session['embeddings'] if subject == 'single' else session[subject]
    current_batch = session['reference_batch_ids'].get(subject)
    if current_batch and current_batch != payload.batch_id:
        raise HTTPException(status_code=409, detail='Lote de referencias diferente; encerre a sessao antes de reiniciar')
    session['reference_batch_ids'][subject] = payload.batch_id
    if len(gallery) >= MAX_REFERENCE_IMAGES:
        raise HTTPException(status_code=400, detail='Limite de referencias temporarias atingido')
    engine = _get_engine()
    result = engine.enroll_from_image(payload.image_base64, pose_label='phase103-reference')
    if result.get('status') != 'ok':
        raise HTTPException(status_code=400, detail='A referencia nao atende aos criterios de qualidade')
    embedding = np.asarray(result.get('embedding'), dtype=np.float32).reshape(-1)
    if embedding.size != 512:
        raise HTTPException(status_code=422, detail='Embedding temporario incompatível com buffalo_l')
    gallery.append(embedding.copy())
    galleries = {'single': session['embeddings']} if subject == 'single' else {
        'subject_a': session['subject_a'], 'subject_b': session['subject_b'],
    }
    return {'subject': subject, 'batch_id': payload.batch_id, 'reference_count': len(gallery), 'embedding_dimension': 512}


def add_reference(owner_id: str, payload: Phase103ReferenceRequest) -> Dict[str, Any]:
    session = _get_session(payload.session_id, owner_id)
    operation_lock = session['operation_lock']
    if not operation_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail='Outra operacao temporaria esta em andamento')
    try:
        return _add_reference_impl(owner_id, payload)
    finally:
        operation_lock.release()


def _quality_rejection_category(evaluation: Dict[str, Any]) -> str:
    """Map the shared evaluator result to a sanitized benchmark category."""
    if not evaluation.get('face_count'):
        return 'face_not_detected'
    message = str(evaluation.get('message') or '').casefold()
    roi_terms = ('centralize', 'distante', 'proximo', 'fora', 'regiao', 'roi')
    if (
        any(term in message for term in roi_terms)
        or not evaluation.get('in_central_region', True)
        or not evaluation.get('predominantly_contained', True)
    ):
        return 'roi_rejected'
    return 'quality_rejected'


def _diagnose_benchmark_frame(
    engine: FaceRecognitionService,
    image_base64: str,
    galleries: Dict[str, List[np.ndarray]],
    temporary_gallery: FaceCacheSnapshot,
) -> Dict[str, Any]:
    """Run the real evaluator/ranker and expose only non-sensitive diagnostics."""
    evaluation = engine.evaluate_image(image_base64)
    base = {
        'comparison_executed': False,
        'reference_count': sum(len(items) for items in galleries.values()),
        'gallery_reference_counts': {key: len(items) for key, items in galleries.items()},
        'embedding_dimension': None,
        'score': None,
        'selected_identity': None,
        'second_score': None,
        'margin': None,
        'margin_valid': False,
        'quality_pass': evaluation.get('status') == 'ok',
    }
    if evaluation.get('status') != 'ok':
        base['status'] = _quality_rejection_category(evaluation)
        return base

    embedding = np.asarray(evaluation.get('embedding'), dtype=np.float32).reshape(-1)
    base['embedding_dimension'] = int(embedding.size)
    if embedding.size != 512 or not np.isfinite(embedding).all() or float(np.linalg.norm(embedding)) <= 0:
        base['status'] = 'embedding_invalid'
        base['quality_pass'] = False
        return base

    matrix = temporary_gallery.embedding_matrix
    matrix_records = temporary_gallery.matrix_records
    if (
        matrix is None
        or not matrix_records
        or getattr(matrix, 'ndim', 0) != 2
        or matrix.shape[0] != len(matrix_records)
        or matrix.shape[1] != embedding.size
    ):
        base['status'] = 'gallery_unavailable'
        return base

    ranked = engine.rank_candidates_in_gallery(embedding, temporary_gallery)
    if not ranked:
        base['status'] = 'gallery_unavailable'
        return base

    best = ranked[0]
    best_record = best['record']
    best_identity = best_record.employee_id
    second = next((item for item in ranked[1:] if item['record'].employee_id != best_identity), None)
    score = float(best['similarity'])
    base['comparison_executed'] = True
    base['score'] = round(score, 4)
    base['selected_identity'] = best_identity
    if second:
        base['second_score'] = round(float(second['similarity']), 4)
        base['margin'] = round(score - float(second['similarity']), 4)
        base['margin_valid'] = True
    base['status'] = 'comparison_completed' if score >= 0.80 else 'score_below_threshold'
    return base


def _compare_impl(owner_id: str, payload: Phase103CompareRequest) -> Dict[str, Any]:
    session = _get_session(payload.session_id, owner_id)
    if payload.images_b2_base64 is None or len(payload.images_b2_base64) != len(payload.images_base64):
        raise HTTPException(status_code=400, detail='Capturas B2 incompletas')
    is_cross = bool(session.get('subject_a') or session.get('subject_b'))
    if is_cross:
        if not payload.capture_a_batch_id or not payload.capture_b_batch_id or payload.capture_a_batch_id == payload.capture_b_batch_id:
            raise HTTPException(status_code=400, detail='Lotes de identificacao A e B sao obrigatorios e distintos')
        capture_batches = (payload.capture_a_batch_id, payload.capture_b_batch_id)
        if not session['subject_a'] or not session['subject_b']:
            raise HTTPException(status_code=400, detail='Capture referencias das Pessoas A e B')
        if payload.images_person_b_base64 is None or payload.images_person_b2_base64 is None:
            raise HTTPException(status_code=400, detail='Capturas independentes da Pessoa B incompletas')
        if len(payload.images_person_b_base64) != len(payload.images_base64) or len(payload.images_person_b2_base64) != len(payload.images_base64):
            raise HTTPException(status_code=400, detail='Capturas das Pessoas A e B devem ter o mesmo tamanho')
    else:
        if not payload.capture_batch_id:
            raise HTTPException(status_code=400, detail='Lote de identificacao obrigatorio')
        capture_batches = (payload.capture_batch_id,)
    if any(batch in session['used_identification_batches'] for batch in capture_batches):
        raise HTTPException(status_code=409, detail='Lote de identificacao ja utilizado ou expirado')
    if not is_cross and not session['embeddings']:
        raise HTTPException(status_code=400, detail='Capture ao menos uma referencia autorizada')
    engine = _get_engine()
    if is_cross:
        result = _compare_cross_session(engine, session, payload)
        session['used_identification_batches'].update(capture_batches)
        return result
    galleries = {'single': session['embeddings']}
    temporary_gallery = _build_temporary_gallery(engine, galleries)
    scenarios = {name: [] for name in ('A', 'B1', 'B2')}
    for index, (image82_data, image95_data) in enumerate(zip(payload.images_base64, payload.images_b2_base64)):
        image82 = _decode_rgb(image82_data)
        image95 = _decode_rgb(image95_data)
        current_crop_data = _current_crop_data(image82)
        current_crop = _decode_rgb(current_crop_data)
        frame_inputs = (
            ('A', current_crop_data, current_crop, 82, 'central_crop'),
            ('B1', image82_data, image82, 82, 'original'),
            ('B2', image95_data, image95, 95, 'original'),
        )
        for name, data_url, image, quality, source in frame_inputs:
            started = time.perf_counter()
            frame = _diagnose_benchmark_frame(engine, data_url, galleries, temporary_gallery)
            frame.update(_jpeg_metadata(data_url, image, quality, source))
            frame['scenario'] = name
            frame['frame_index'] = index + 1
            frame['score_pass'] = frame['status'] == 'comparison_completed'
            frame['processing_ms'] = round((time.perf_counter() - started) * 1000, 3)
            scenarios[name].append(frame)

    a_scores = {
        frame['frame_index']: frame['score']
        for frame in scenarios['A']
        if frame.get('comparison_executed') and frame.get('score') is not None
    }
    for name in ('B1', 'B2'):
        for frame in scenarios[name]:
            reference_score = a_scores.get(frame['frame_index'])
            frame['score_delta_vs_A'] = (
                round(frame['score'] - reference_score, 4)
                if frame.get('comparison_executed') and reference_score is not None
                else None
            )
    output = {}
    for name, frames in scenarios.items():
        score_passes = sum(1 for frame in frames if frame['status'] == 'comparison_completed')
        processing_times = sorted(frame['processing_ms'] for frame in frames)
        output[name] = {
            'frames': frames,
            'score_pass_count': score_passes,
            'consensus_two_frames': score_passes >= 2,
            'margin_evaluable': False,
            'margin_note': 'Nao avaliavel com uma unica identidade temporaria.',
            'mean_processing_ms': round(sum(frame['processing_ms'] for frame in frames) / len(frames), 3),
            'p95_processing_ms': round(processing_times[max(0, math.ceil(len(processing_times) * 0.95) - 1)], 3),
            'valid_score_count': sum(1 for frame in frames if frame.get('comparison_executed')),
        }
    session['used_identification_batches'].update(capture_batches)
    return {'mode': 'single', 'scenarios': output, 'model': 'buffalo_l', 'threshold': 0.80, 'margin_threshold': 0.04, 'consensus_required': 2}


def compare(owner_id: str, payload: Phase103CompareRequest) -> Dict[str, Any]:
    session = _get_session(payload.session_id, owner_id)
    operation_lock = session['operation_lock']
    if not operation_lock.acquire(blocking=False):
        raise HTTPException(status_code=409, detail='Outra comparacao temporaria esta em andamento')
    try:
        return _compare_impl(owner_id, payload)
    finally:
        operation_lock.release()


def _run_cross_gallery(
    engine: FaceRecognitionService,
    image82_data_list: List[str],
    image95_data_list: List[str],
    galleries: Dict[str, List[np.ndarray]],
    expected_identity: str,
) -> Dict[str, Any]:
    temporary_gallery = _build_temporary_gallery(engine, galleries)
    scenarios = {name: [] for name in ('A', 'B1', 'B2')}
    for index, (image82_data, image95_data) in enumerate(zip(image82_data_list, image95_data_list)):
        image82 = _decode_rgb(image82_data)
        image95 = _decode_rgb(image95_data)
        current_crop_data = _current_crop_data(image82)
        current_crop = _decode_rgb(current_crop_data)
        frame_inputs = (
            ('A', current_crop_data, current_crop, 82, 'central_crop'),
            ('B1', image82_data, image82, 82, 'original'),
            ('B2', image95_data, image95, 95, 'original'),
        )
        for name, data_url, image, quality, source in frame_inputs:
            started = time.perf_counter()
            frame = _diagnose_benchmark_frame(engine, data_url, galleries, temporary_gallery)
            frame.update(_jpeg_metadata(data_url, image, quality, source))
            frame['scenario'] = name
            frame['frame_index'] = index + 1
            frame['expected_identity'] = expected_identity
            frame['identity_matches_expected'] = frame.get('selected_identity') == expected_identity
            frame['score_pass'] = frame['status'] == 'comparison_completed'
            frame['false_acceptance'] = bool(frame['score_pass'] and not frame['identity_matches_expected'])
            frame['processing_ms'] = round((time.perf_counter() - started) * 1000, 3)
            scenarios[name].append(frame)

    output = {}
    has_distinct_candidates = len(galleries) > 1
    for name, frames in scenarios.items():
        score_passes = sum(1 for frame in frames if frame['score_pass'])
        processing_times = sorted(frame['processing_ms'] for frame in frames)
        margin_passes = [
            frame.get('margin_valid') and frame.get('margin', 0) >= 0.04
            for frame in frames
        ]
        margin_ok = all(margin_passes) if has_distinct_candidates else True
        consensus = score_passes >= 2
        output[name] = {
            'frames': frames,
            'gallery_identities': list(galleries),
            'expected_identity': expected_identity,
            'score_pass_count': score_passes,
            'consensus_two_frames': consensus,
            'margin_evaluable': has_distinct_candidates,
            'margin_threshold': 0.04 if has_distinct_candidates else None,
            'margin_pass_count': sum(1 for value in margin_passes if value),
            'decision_approved': bool(consensus and margin_ok),
            'identity_correct': bool(consensus and all(frame['identity_matches_expected'] for frame in frames)),
            'false_acceptance_observed': any(frame['false_acceptance'] for frame in frames),
            'mean_processing_ms': round(sum(frame['processing_ms'] for frame in frames) / len(frames), 3),
            'p95_processing_ms': round(processing_times[max(0, math.ceil(len(processing_times) * 0.95) - 1)], 3),
        }
    return output


def _compare_cross_session(
    engine: FaceRecognitionService,
    session: Dict[str, Any],
    payload: Phase103CompareRequest,
) -> Dict[str, Any]:
    galleries = {
        'subject_a': session['subject_a'],
        'subject_b': session['subject_b'],
    }
    tests = {}
    for captured_identity, images82, images95 in (
        ('subject_a', payload.images_base64, payload.images_b2_base64),
        ('subject_b', payload.images_person_b_base64, payload.images_person_b2_base64),
    ):
        tests[captured_identity] = {
            'own_gallery': _run_cross_gallery(
                engine, images82, images95,
                {captured_identity: galleries[captured_identity]}, captured_identity,
            ),
            'other_gallery': _run_cross_gallery(
                engine, images82, images95,
                {'subject_b' if captured_identity == 'subject_a' else 'subject_a':
                 galleries['subject_b' if captured_identity == 'subject_a' else 'subject_a']},
                captured_identity,
            ),
            'joint_gallery': _run_cross_gallery(
                engine, images82, images95, galleries, captured_identity,
            ),
        }
    return {
        'mode': 'cross',
        'tests': tests,
        'model': 'buffalo_l',
        'threshold': 0.80,
        'margin_threshold': 0.04,
        'consensus_required': 2,
    }


def close_session(owner_id: str, payload: Phase103CloseRequest) -> Dict[str, bool]:
    _purge_expired()
    if payload.session_id:
        with _session_lock:
            session = _sessions.get(payload.session_id)
        if session and session['owner_id'] != owner_id:
            raise HTTPException(status_code=404, detail='Sessao de benchmark inexistente ou expirada')
        if session:
            if not _clear_session(payload.session_id):
                raise HTTPException(status_code=409, detail='Operacao temporaria em andamento')
        return {'cleared': True}

    with _session_lock:
        owned_ids = [
            session_id for session_id, session in _sessions.items()
            if session['owner_id'] == owner_id
        ]
    for session_id in owned_ids:
        _clear_session(session_id)
    return {'cleared': True}
