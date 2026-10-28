import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from bson import ObjectId
from fastapi import HTTPException, Request, status
from fastapi.testclient import TestClient

BACKEND_DIR = Path(__file__).resolve().parents[1] / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import server as backend_server  # noqa: E402


class FakeCursor:
    def __init__(self, documents):
        self.documents = [dict(document) for document in documents]

    def sort(self, field_name, direction):
        reverse = direction == -1
        self.documents.sort(key=lambda item: item.get(field_name) or '', reverse=reverse)
        return self

    async def to_list(self, limit):
        return self.documents[:limit]


class FakeInsertOneResult:
    def __init__(self, inserted_id):
        self.inserted_id = inserted_id


class FakeUpdateResult:
    def __init__(self, matched_count):
        self.matched_count = matched_count


class FakeCollection:
    def __init__(self, documents=None):
        self.documents = [dict(document) for document in (documents or [])]

    def _matches(self, document, query):
        for key, expected in (query or {}).items():
            actual = document.get(key)
            if isinstance(expected, dict):
                if '$in' in expected:
                    expected_values = {str(value) for value in expected['$in']}
                    if str(actual) not in expected_values:
                        return False
                if '$ne' in expected and actual == expected['$ne']:
                    return False
                continue
            if str(actual) != str(expected):
                return False
        return True

    def find(self, query=None):
        return FakeCursor([document for document in self.documents if self._matches(document, query or {})])

    async def find_one(self, query):
        for document in self.documents:
            if self._matches(document, query):
                return dict(document)
        return None

    async def insert_one(self, document):
        stored = dict(document)
        stored['_id'] = stored.get('_id', ObjectId())
        self.documents.append(stored)
        return FakeInsertOneResult(stored['_id'])

    async def update_one(self, query, update):
        for index, document in enumerate(self.documents):
            if not self._matches(document, query):
                continue
            updated = dict(document)
            for key, value in update.get('$set', {}).items():
                updated[key] = value
            for key, value in update.get('$inc', {}).items():
                updated[key] = (updated.get(key, 0) or 0) + value
            self.documents[index] = updated
            return FakeUpdateResult(1)
        return FakeUpdateResult(0)

    async def count_documents(self, query=None):
        return len([document for document in self.documents if self._matches(document, query or {})])


class DeliveryCourseDB:
    def __init__(self):
        now = datetime.now(timezone.utc)
        self.employee_id = ObjectId()
        self.epi_free_id = ObjectId()
        self.epi_block_false_id = ObjectId()
        self.epi_required_id = ObjectId()
        self.epi_second_required_id = ObjectId()
        self.kit_id = ObjectId()
        self.attendant_id = ObjectId()
        self.course_false_id = ObjectId()
        self.course_required_id = ObjectId()
        self.course_second_id = ObjectId()

        self.employees = FakeCollection([
            {'_id': self.employee_id, 'full_name': 'Colaborador Teste', 'status': 'active', 'photo_path': '/uploads/teste.jpg'},
        ])
        self.epis = FakeCollection([
            {'_id': self.epi_free_id, 'name': 'Luva Livre', 'current_stock': 5, 'type_category': 'Mao'},
            {'_id': self.epi_block_false_id, 'name': 'Capacete Curso Sem Bloqueio', 'current_stock': 5, 'type_category': 'Cabeca'},
            {'_id': self.epi_required_id, 'name': 'Cinto de Seguranca', 'current_stock': 5, 'type_category': 'Altura'},
            {'_id': self.epi_second_required_id, 'name': 'Talabarte', 'current_stock': 5, 'type_category': 'Altura'},
        ])
        self.epi_variations = FakeCollection([
            {'_id': ObjectId(), 'epi_id': str(self.epi_free_id), 'current_stock': 5, 'status': 'ativo', 'size': None},
            {'_id': ObjectId(), 'epi_id': str(self.epi_block_false_id), 'current_stock': 5, 'status': 'ativo', 'size': None},
            {'_id': ObjectId(), 'epi_id': str(self.epi_required_id), 'current_stock': 5, 'status': 'ativo', 'size': None},
            {'_id': ObjectId(), 'epi_id': str(self.epi_second_required_id), 'current_stock': 5, 'status': 'ativo', 'size': None},
        ])
        self.courses = FakeCollection([
            {'_id': self.course_false_id, 'name': 'Curso Informativo', 'active': True, 'block_epi_delivery': False, 'alert_days_before_expiration': 30},
            {'_id': self.course_required_id, 'name': 'NR35', 'active': True, 'block_epi_delivery': True, 'alert_days_before_expiration': 30},
            {'_id': self.course_second_id, 'name': 'NR33', 'active': True, 'block_epi_delivery': True, 'alert_days_before_expiration': 30},
        ])
        self.course_epi_links = FakeCollection([
            {'_id': ObjectId(), 'course_id': str(self.course_false_id), 'epi_id': str(self.epi_block_false_id)},
            {'_id': ObjectId(), 'course_id': str(self.course_required_id), 'epi_id': str(self.epi_required_id)},
            {'_id': ObjectId(), 'course_id': str(self.course_second_id), 'epi_id': str(self.epi_required_id)},
            {'_id': ObjectId(), 'course_id': str(self.course_required_id), 'epi_id': str(self.epi_second_required_id)},
        ])
        self.employee_courses = FakeCollection([])
        self.deliveries = FakeCollection([])
        self.stock_movements = FakeCollection([])
        self.kits = FakeCollection([
            {'_id': self.kit_id, 'name': 'Kit Altura'},
        ])
        self.counter_attendants = FakeCollection([
            {'_id': self.attendant_id, 'full_name': 'Atendente Balcao', 'is_active': True},
        ])
        self.audit_logs = FakeCollection([])
        self.now = now

    def stock_for(self, epi_id):
        return next(item for item in self.epi_variations.documents if item['epi_id'] == str(epi_id))['current_stock']

    def add_certificate(self, course_id, expires_in_days, active=True, status_value=None, created_days_ago=0):
        self.employee_courses.documents.append({
            '_id': ObjectId(),
            'employee_id': str(self.employee_id),
            'course_id': str(course_id),
            'start_date': self.now - timedelta(days=365),
            'expiration_date': self.now + timedelta(days=expires_in_days),
            'active': active,
            'status': status_value,
            'created_at': self.now - timedelta(days=created_days_ago),
            'updated_at': self.now - timedelta(days=created_days_ago),
        })


@pytest.fixture
def client(monkeypatch):
    fake_db = DeliveryCourseDB()

    async def fake_get_db():
        return fake_db

    async def fake_get_current_user(request: Request):
        header = request.headers.get('Authorization')
        if not header or not header.startswith('Bearer '):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Credenciais invalidas')
        raw = header.replace('Bearer ', '').strip()
        role, _, username = raw.partition(':')
        return {'id': 'user-1', 'username': username or role, 'role': role, 'is_active': True}

    async def fake_create_variation_from_legacy_epi(db, epi):
        return None

    monkeypatch.setattr(backend_server, 'get_db', fake_get_db)
    monkeypatch.setattr(backend_server, 'create_variation_from_legacy_epi', fake_create_variation_from_legacy_epi)
    backend_server.app.dependency_overrides[backend_server.get_current_user] = fake_get_current_user
    backend_server.app.router.on_startup.clear()
    backend_server.app.router.on_shutdown.clear()
    with TestClient(backend_server.app) as test_client:
        yield test_client, fake_db
    backend_server.app.dependency_overrides.clear()


def auth_headers(role, username=None):
    value = role if username is None else f'{role}:{username}'
    return {'Authorization': f'Bearer {value}'}


def delivery_payload(db, epi_id, **extra):
    payload = {
        'employee_id': str(db.employee_id),
        'delivery_type': 'delivery',
        'is_return': False,
        'facial_match_score': 0.91,
        'facial_validation_status': 'approved',
        'items': [{'epi_id': str(epi_id), 'quantity': 1}],
    }
    payload.update(extra)
    return payload


def assert_no_side_effects(db, before):
    assert len(db.deliveries.documents) == before['deliveries']
    assert len(db.stock_movements.documents) == before['stock_movements']
    assert db.stock_for(db.epi_required_id) == before['stock']


def test_epi_without_course_is_allowed(client):
    test_client, db = client
    response = test_client.post('/api/deliveries', headers=auth_headers('admin'), json=delivery_payload(db, db.epi_free_id))
    assert response.status_code == 201
    assert len(db.deliveries.documents) == 1
    assert len(db.stock_movements.documents) == 1
    assert db.stock_for(db.epi_free_id) == 4


def test_course_linked_with_block_false_is_allowed(client):
    test_client, db = client
    response = test_client.post('/api/deliveries', headers=auth_headers('admin'), json=delivery_payload(db, db.epi_block_false_id))
    assert response.status_code == 201


def test_required_course_with_valid_certificate_is_allowed(client):
    test_client, db = client
    db.add_certificate(db.course_required_id, 90)
    db.add_certificate(db.course_second_id, 90)
    response = test_client.post('/api/deliveries', headers=auth_headers('almoxarifado'), json=delivery_payload(db, db.epi_required_id))
    assert response.status_code == 201


def test_required_course_without_certificate_returns_409_and_no_side_effects(client):
    test_client, db = client
    before = {'deliveries': len(db.deliveries.documents), 'stock_movements': len(db.stock_movements.documents), 'stock': db.stock_for(db.epi_required_id)}
    response = test_client.post('/api/deliveries', headers=auth_headers('admin'), json=delivery_payload(db, db.epi_required_id))
    assert response.status_code == 409
    detail = response.json()['detail']
    assert detail['code'] == 'COURSE_REQUIRED'
    assert detail['status'] == 'missing'
    assert detail['course_name'] == 'NR35'
    assert detail['epi_name'] == 'Cinto de Seguranca'
    assert len(detail['blocked_courses']) == 2
    assert len(db.audit_logs.documents) == 1
    assert_no_side_effects(db, before)


def test_expired_certificate_returns_409_with_expiration_date(client):
    test_client, db = client
    db.add_certificate(db.course_required_id, -1)
    db.add_certificate(db.course_second_id, 90)
    before = {'deliveries': 0, 'stock_movements': 0, 'stock': db.stock_for(db.epi_required_id)}
    response = test_client.post('/api/deliveries', headers=auth_headers('admin'), json=delivery_payload(db, db.epi_required_id))
    assert response.status_code == 409
    detail = response.json()['detail']
    assert detail['status'] == 'expired'
    assert detail['expiration_date'] is not None
    assert 'vencido' in detail['message']
    assert_no_side_effects(db, before)


def test_inactive_and_cancelled_certificates_return_specific_status(client):
    test_client, db = client
    db.add_certificate(db.course_required_id, 90, active=False)
    db.add_certificate(db.course_second_id, 90)
    inactive = test_client.post('/api/deliveries', headers=auth_headers('admin'), json=delivery_payload(db, db.epi_required_id))
    assert inactive.status_code == 409
    assert inactive.json()['detail']['status'] == 'inactive'

    db.employee_courses.documents = [item for item in db.employee_courses.documents if item['course_id'] != str(db.course_required_id)]
    db.audit_logs.documents.clear()
    db.add_certificate(db.course_required_id, 90, active=True, status_value='cancelled')
    cancelled = test_client.post('/api/deliveries', headers=auth_headers('admin'), json=delivery_payload(db, db.epi_required_id))
    assert cancelled.status_code == 409
    assert cancelled.json()['detail']['status'] == 'cancelled'


def test_expiring_but_valid_certificate_is_allowed(client):
    test_client, db = client
    db.add_certificate(db.course_required_id, 1)
    db.add_certificate(db.course_second_id, 1)
    response = test_client.post('/api/deliveries', headers=auth_headers('admin'), json=delivery_payload(db, db.epi_required_id))
    assert response.status_code == 201


def test_valid_renewal_overrides_old_expired_history(client):
    test_client, db = client
    db.add_certificate(db.course_required_id, -30, created_days_ago=30)
    db.add_certificate(db.course_required_id, 120)
    db.add_certificate(db.course_second_id, 120)
    response = test_client.post('/api/deliveries', headers=auth_headers('admin'), json=delivery_payload(db, db.epi_required_id))
    assert response.status_code == 201


def test_multiple_required_courses_block_when_one_is_expired(client):
    test_client, db = client
    db.add_certificate(db.course_required_id, 120)
    db.add_certificate(db.course_second_id, -1)
    response = test_client.post('/api/deliveries', headers=auth_headers('admin'), json=delivery_payload(db, db.epi_required_id))
    assert response.status_code == 409
    detail = response.json()['detail']
    assert detail['status'] == 'expired'
    assert [item['course_name'] for item in detail['blocked_courses']] == ['NR33']


def test_kit_item_block_returns_kit_course_required(client):
    test_client, db = client
    payload = delivery_payload(db, db.epi_required_id)
    payload['items'][0]['kit_id'] = str(db.kit_id)
    response = test_client.post('/api/deliveries', headers=auth_headers('admin'), json=payload)
    assert response.status_code == 409
    detail = response.json()['detail']
    assert detail['code'] == 'KIT_COURSE_REQUIRED'
    assert detail['blocked_items'][0]['kit_name'] == 'Kit Altura'


def test_balcao_jac_without_attendant_still_requires_attendant(client):
    test_client, db = client
    db.add_certificate(db.course_required_id, -1)
    response = test_client.post('/api/deliveries', headers=auth_headers('almoxarifado', 'balcao_jac'), json=delivery_payload(db, db.epi_required_id))
    assert response.status_code == 422
    assert 'ATENDENTE' in response.json()['detail']
    assert len(db.audit_logs.documents) == 0


def test_balcao_jac_with_attendant_and_expired_course_blocks_by_course(client):
    test_client, db = client
    db.add_certificate(db.course_required_id, -1)
    db.add_certificate(db.course_second_id, 90)
    payload = delivery_payload(db, db.epi_required_id, attendant_id=str(db.attendant_id))
    response = test_client.post('/api/deliveries', headers=auth_headers('almoxarifado', 'balcao_jac'), json=payload)
    assert response.status_code == 409
    assert response.json()['detail']['code'] == 'COURSE_REQUIRED'
    assert len(db.audit_logs.documents) == 1
