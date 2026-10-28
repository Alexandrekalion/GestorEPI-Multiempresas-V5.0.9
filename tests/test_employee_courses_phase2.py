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
        self.documents = list(documents)

    async def to_list(self, limit):
        return self.documents[:limit]

    def sort(self, field_name, direction):
        reverse = direction == -1
        self.documents.sort(key=lambda item: item.get(field_name) or '', reverse=reverse)
        return self


class FakeInsertOneResult:
    def __init__(self, inserted_id):
        self.inserted_id = inserted_id


class FakeUpdateResult:
    def __init__(self, matched_count):
        self.matched_count = matched_count


class FakeDeleteResult:
    def __init__(self, deleted_count):
        self.deleted_count = deleted_count


class FakeCollection:
    def __init__(self, initial_documents=None):
        self.documents = [dict(item) for item in (initial_documents or [])]

    def _matches(self, document, query):
        if not query:
            return True
        for key, expected in query.items():
            actual = document.get(key)
            if isinstance(expected, dict):
                if '$in' in expected and actual not in expected['$in']:
                    return False
                if '$ne' in expected and actual == expected['$ne']:
                    return False
                continue
            if actual != expected:
                return False
        return True

    def find(self, query=None):
        return FakeCursor([dict(doc) for doc in self.documents if self._matches(doc, query or {})])

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
            if self._matches(document, query):
                updated = dict(document)
                updated.update(update.get('$set', {}))
                self.documents[index] = updated
                return FakeUpdateResult(1)
        return FakeUpdateResult(0)

    async def delete_one(self, query):
        for index, document in enumerate(self.documents):
            if self._matches(document, query):
                self.documents.pop(index)
                return FakeDeleteResult(1)
        return FakeDeleteResult(0)


class FakeDB:
    def __init__(self):
        now = datetime.now(timezone.utc)
        self.employee_active_id = ObjectId()
        self.employee_inactive_id = ObjectId()
        self.course_active_id = ObjectId()
        self.course_inactive_id = ObjectId()
        self.employees = FakeCollection([
            {'_id': self.employee_active_id, 'full_name': 'Colaborador Ativo', 'status': 'active'},
            {'_id': self.employee_inactive_id, 'full_name': 'Colaborador Inativo', 'status': 'inactive'},
        ])
        self.courses = FakeCollection([
            {'_id': self.course_active_id, 'name': 'NR35', 'active': True, 'alert_days_before_expiration': 30},
            {'_id': self.course_inactive_id, 'name': 'NR10', 'active': False, 'alert_days_before_expiration': 15},
        ])
        self.employee_courses = FakeCollection([
            {
                '_id': ObjectId(),
                'employee_id': str(self.employee_active_id),
                'course_id': str(self.course_active_id),
                'start_date': now - timedelta(days=300),
                'expiration_date': now - timedelta(days=10),
                'certificate_number': 'OLD-1',
                'training_provider': 'Treinamento Antigo',
                'notes': 'Historico',
                'active': True,
                'created_at': now - timedelta(days=300),
                'updated_at': now - timedelta(days=300),
                'created_by': 'admin',
                'updated_by': 'admin',
                'renewed_from_id': None,
                'renewed_into_id': None,
                'deactivated_at': None,
                'deactivated_by': None,
                'deactivation_reason': None,
            }
        ])
        self.companies = FakeCollection([])
        self.audit_logs = FakeCollection([])


@pytest.fixture
def client(monkeypatch):
    fake_db = FakeDB()

    async def fake_get_db():
        return fake_db

    async def fake_get_current_user(request: Request):
        header = request.headers.get('Authorization')
        if not header or not header.startswith('Bearer '):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Credenciais invalidas', headers={'WWW-Authenticate': 'Bearer'})
        raw = header.replace('Bearer ', '').strip()
        role, _, username = raw.partition(':')
        return {
            'id': 'user-1',
            'username': username or role,
            'email': f'{role}@teste.local',
            'role': role,
            'is_active': True,
        }

    async def fake_write_audit_log(db, action, entity_type, entity_id, current_user, **kwargs):
        await db.audit_logs.insert_one({
            'action': action,
            'entity_type': entity_type,
            'entity_id': entity_id,
            'performed_by_username': current_user.get('username'),
            'metadata': kwargs.get('metadata') or {},
            'reason': kwargs.get('reason'),
        })

    monkeypatch.setattr(backend_server, 'get_db', fake_get_db)
    monkeypatch.setattr(backend_server, 'write_audit_log', fake_write_audit_log)
    backend_server.app.dependency_overrides[backend_server.get_current_user] = fake_get_current_user
    backend_server.app.router.on_startup.clear()
    backend_server.app.router.on_shutdown.clear()

    with TestClient(backend_server.app) as test_client:
        yield test_client, fake_db

    backend_server.app.dependency_overrides.clear()


def auth_headers(role, username=None):
    value = role if username is None else f'{role}:{username}'
    return {'Authorization': f'Bearer {value}'}


def iso_now_plus(days):
    return (datetime.now(timezone.utc) + timedelta(days=days)).replace(microsecond=0).isoformat()


def test_employee_courses_requires_authentication(client):
    test_client, fake_db = client
    response = test_client.get(f'/api/employees/{fake_db.employee_active_id}/courses')
    assert response.status_code == 401


def test_admin_can_create_employee_course_with_attachment(client):
    test_client, fake_db = client
    response = test_client.post(
        f'/api/employees/{fake_db.employee_active_id}/courses',
        headers=auth_headers('admin'),
        data={
            'course_id': str(fake_db.course_active_id),
            'start_date': iso_now_plus(-5),
            'expiration_date': iso_now_plus(365),
            'certificate_number': ' CERT-001 ',
            'training_provider': ' Escola X ',
            'notes': ' Observacao teste ',
        },
        files={'certificate_file': ('certificado.pdf', b'%PDF-1.4 teste', 'application/pdf')},
    )
    assert response.status_code == 201
    payload = response.json()
    assert payload['course_name'] == 'NR35'
    assert payload['certificate_number'] == 'CERT-001'
    assert payload['training_provider'] == 'Escola X'
    assert payload['certificate_file_path'].startswith('/uploads/employee_courses/')


def test_invalid_date_range_returns_validation_error(client):
    test_client, fake_db = client
    response = test_client.post(
        f'/api/employees/{fake_db.employee_active_id}/courses',
        headers=auth_headers('admin'),
        json={
            'course_id': str(fake_db.course_active_id),
            'start_date': iso_now_plus(10),
            'expiration_date': iso_now_plus(5),
        },
    )
    assert response.status_code == 422


@pytest.mark.parametrize('role', ['gestor', 'rh'])
def test_read_only_roles_can_view_but_not_create(client, role):
    test_client, fake_db = client
    get_response = test_client.get(f'/api/employees/{fake_db.employee_active_id}/courses', headers=auth_headers(role))
    assert get_response.status_code == 200
    post_response = test_client.post(
        f'/api/employees/{fake_db.employee_active_id}/courses',
        headers=auth_headers(role),
        json={
            'course_id': str(fake_db.course_active_id),
            'start_date': iso_now_plus(-1),
            'expiration_date': iso_now_plus(30),
        },
    )
    assert post_response.status_code == 403


def test_almox_can_create_edit_and_renew_but_not_deactivate(client):
    test_client, fake_db = client
    created = test_client.post(
        f'/api/employees/{fake_db.employee_active_id}/courses',
        headers=auth_headers('almoxarifado', 'balcao_jac'),
        json={
            'course_id': str(fake_db.course_active_id),
            'start_date': iso_now_plus(-2),
            'expiration_date': iso_now_plus(120),
            'certificate_number': 'BALCAO-1',
        },
    )
    assert created.status_code == 201
    employee_course_id = created.json()['id']

    updated = test_client.patch(
        f'/api/employees/{fake_db.employee_active_id}/courses/{employee_course_id}',
        headers=auth_headers('almoxarifado', 'balcao_jac'),
        json={'notes': 'Atualizado pelo balcao'},
    )
    assert updated.status_code == 200
    assert updated.json()['notes'] == 'Atualizado pelo balcao'

    renewed = test_client.post(
        f'/api/employees/{fake_db.employee_active_id}/courses/{employee_course_id}/renew',
        headers=auth_headers('almoxarifado', 'balcao_jac'),
        json={
            'start_date': iso_now_plus(121),
            'expiration_date': iso_now_plus(300),
            'certificate_number': 'BALCAO-2',
        },
    )
    assert renewed.status_code == 201

    deactivated = test_client.post(
        f'/api/employees/{fake_db.employee_active_id}/courses/{employee_course_id}/deactivate',
        headers=auth_headers('almoxarifado', 'balcao_jac'),
        json={'reason': 'Teste'},
    )
    assert deactivated.status_code == 403


def test_security_can_deactivate_certificate(client):
    test_client, fake_db = client
    created = test_client.post(
        f'/api/employees/{fake_db.employee_active_id}/courses',
        headers=auth_headers('seguranca_trabalho'),
        json={
            'course_id': str(fake_db.course_active_id),
            'start_date': iso_now_plus(-2),
            'expiration_date': iso_now_plus(120),
        },
    )
    employee_course_id = created.json()['id']
    response = test_client.post(
        f'/api/employees/{fake_db.employee_active_id}/courses/{employee_course_id}/deactivate',
        headers=auth_headers('seguranca_trabalho'),
        json={'reason': 'Lancamento incorreto'},
    )
    assert response.status_code == 200
    assert response.json()['active'] is False
    assert response.json()['status'] == 'inactive'


def test_renew_preserves_history_and_marks_new_record_as_current(client):
    test_client, fake_db = client
    original_id = str(fake_db.employee_courses.documents[0]['_id'])
    response = test_client.post(
        f'/api/employees/{fake_db.employee_active_id}/courses/{original_id}/renew',
        headers=auth_headers('admin'),
        json={
            'start_date': iso_now_plus(1),
            'expiration_date': iso_now_plus(400),
            'certificate_number': 'NEW-1',
            'training_provider': 'Renovadora',
        },
    )
    assert response.status_code == 201
    new_payload = response.json()
    assert new_payload['renewed_from_id'] == original_id
    listed = test_client.get(f'/api/employees/{fake_db.employee_active_id}/courses', headers=auth_headers('admin'))
    assert listed.status_code == 200
    items = listed.json()
    assert len(items) == 2
    current_items = [item for item in items if item['is_current']]
    assert len(current_items) == 1
    assert current_items[0]['id'] == new_payload['id']


def test_status_is_computed_as_valid_expiring_and_expired(client):
    test_client, fake_db = client
    db = fake_db
    now = datetime.now(timezone.utc)
    db.employee_courses.documents.extend([
        {
            '_id': ObjectId(), 'employee_id': str(db.employee_active_id), 'course_id': str(db.course_active_id),
            'start_date': now - timedelta(days=10), 'expiration_date': now + timedelta(days=5), 'active': True,
            'created_at': now, 'updated_at': now, 'created_by': 'admin', 'updated_by': 'admin'
        },
        {
            '_id': ObjectId(), 'employee_id': str(db.employee_active_id), 'course_id': str(db.course_active_id),
            'start_date': now - timedelta(days=10), 'expiration_date': now + timedelta(days=90), 'active': True,
            'created_at': now, 'updated_at': now, 'created_by': 'admin', 'updated_by': 'admin'
        },
    ])
    response = test_client.get(f'/api/employees/{fake_db.employee_active_id}/courses', headers=auth_headers('admin'))
    assert response.status_code == 200
    statuses = {item['status'] for item in response.json()}
    assert 'expired' in statuses
    assert 'expiring' in statuses
    assert 'valid' in statuses


def test_missing_employee_and_course_are_validated(client):
    test_client, fake_db = client
    missing_employee = test_client.get(f'/api/employees/{ObjectId()}/courses', headers=auth_headers('admin'))
    assert missing_employee.status_code == 404
    missing_course = test_client.post(
        f'/api/employees/{fake_db.employee_active_id}/courses',
        headers=auth_headers('admin'),
        json={
            'course_id': str(ObjectId()),
            'start_date': iso_now_plus(-1),
            'expiration_date': iso_now_plus(50),
        },
    )
    assert missing_course.status_code == 404


def test_inactive_course_and_inactive_employee_are_blocked(client):
    test_client, fake_db = client
    inactive_course = test_client.post(
        f'/api/employees/{fake_db.employee_active_id}/courses',
        headers=auth_headers('admin'),
        json={
            'course_id': str(fake_db.course_inactive_id),
            'start_date': iso_now_plus(-1),
            'expiration_date': iso_now_plus(50),
        },
    )
    assert inactive_course.status_code == 400

    inactive_employee = test_client.post(
        f'/api/employees/{fake_db.employee_inactive_id}/courses',
        headers=auth_headers('almoxarifado'),
        json={
            'course_id': str(fake_db.course_active_id),
            'start_date': iso_now_plus(-1),
            'expiration_date': iso_now_plus(50),
        },
    )
    assert inactive_employee.status_code == 400


def test_audit_log_is_written_for_mutations(client):
    test_client, fake_db = client
    response = test_client.post(
        f'/api/employees/{fake_db.employee_active_id}/courses',
        headers=auth_headers('admin'),
        json={
            'course_id': str(fake_db.course_active_id),
            'start_date': iso_now_plus(-1),
            'expiration_date': iso_now_plus(50),
        },
    )
    assert response.status_code == 201
    assert any(item['action'] == 'EMPLOYEE_COURSE_CREATED' for item in fake_db.audit_logs.documents)
