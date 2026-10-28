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


class FakeCollection:
    def __init__(self, documents):
        self.documents = [dict(document) for document in documents]

    def _matches(self, document, query):
        for key, expected in (query or {}).items():
            actual = document.get(key)
            if isinstance(expected, dict):
                if '$in' in expected and actual not in expected['$in']:
                    return False
                if '$ne' in expected and actual == expected['$ne']:
                    return False
            elif actual != expected:
                return False
        return True

    def find(self, query=None):
        return FakeCursor([dict(document) for document in self.documents if self._matches(document, query)])


class AlertDB:
    def __init__(self):
        now = datetime.now(timezone.utc)
        self.company_id = ObjectId()
        self.active_employee_id = ObjectId()
        self.inactive_employee_id = ObjectId()
        ids = {name: ObjectId() for name in ('expiring', 'expired_a', 'expired_b', 'valid', 'zero', 'inactive', 'renewed')}

        self.companies = FakeCollection([{'_id': self.company_id, 'legal_name': 'Empresa de Teste'}])
        self.employees = FakeCollection([
            {'_id': self.active_employee_id, 'full_name': 'Colaborador Ativo', 'company_id': str(self.company_id), 'department': 'Montagem', 'status': 'active'},
            {'_id': self.inactive_employee_id, 'full_name': 'Colaborador Inativo', 'company_id': str(self.company_id), 'department': 'Obra', 'status': 'inactive'},
        ])
        self.courses = FakeCollection([
            {'_id': ids['expiring'], 'name': 'NR35', 'active': True, 'alert_days_before_expiration': 30},
            {'_id': ids['expired_a'], 'name': 'NR10', 'active': True, 'alert_days_before_expiration': 30},
            {'_id': ids['expired_b'], 'name': 'NR33', 'active': True, 'alert_days_before_expiration': 30},
            {'_id': ids['valid'], 'name': 'NR18', 'active': True, 'alert_days_before_expiration': 30},
            {'_id': ids['zero'], 'name': 'NR06', 'active': True, 'alert_days_before_expiration': 0},
            {'_id': ids['inactive'], 'name': 'Curso Inativo', 'active': False, 'alert_days_before_expiration': 30},
            {'_id': ids['renewed'], 'name': 'Curso Renovado', 'active': True, 'alert_days_before_expiration': 30},
        ])

        def record(course_id, expires_in_days, employee_id=None, active=True):
            return {
                '_id': ObjectId(),
                'employee_id': str(employee_id or self.active_employee_id),
                'course_id': str(course_id),
                'expiration_date': now + timedelta(days=expires_in_days),
                'start_date': now - timedelta(days=365),
                'active': active,
                'created_at': now,
                'updated_at': now,
            }

        self.employee_courses = FakeCollection([
            record(ids['expiring'], 10),
            record(ids['expired_a'], -21),
            record(ids['expired_b'], -45),
            record(ids['valid'], 31),
            record(ids['zero'], 0),
            record(ids['inactive'], 5),
            record(ids['expiring'], -4, active=False),
            record(ids['expired_a'], -3, employee_id=self.inactive_employee_id),
            record(ids['renewed'], -10),
            record(ids['renewed'], 120),
        ])


@pytest.fixture
def client(monkeypatch):
    fake_db = AlertDB()

    async def fake_get_db():
        return fake_db

    async def fake_get_current_user(request: Request):
        header = request.headers.get('Authorization')
        if not header or not header.startswith('Bearer '):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Credenciais invalidas')
        role_value = header.replace('Bearer ', '').strip()
        role, _, username = role_value.partition(':')
        return {'id': 'test-user', 'username': username or role, 'role': role, 'is_active': True}

    monkeypatch.setattr(backend_server, 'get_db', fake_get_db)
    backend_server.app.dependency_overrides[backend_server.get_current_user] = fake_get_current_user
    backend_server.app.router.on_startup.clear()
    backend_server.app.router.on_shutdown.clear()
    with TestClient(backend_server.app) as test_client:
        yield test_client
    backend_server.app.dependency_overrides.clear()


def auth_headers(role):
    return {'Authorization': f'Bearer {role}'}


def test_course_alerts_include_only_operational_current_certificates(client):
    response = client.get('/api/alerts/courses', headers=auth_headers('admin'))
    assert response.status_code == 200
    payload = response.json()
    assert payload['summary'] == {'expiring': 1, 'expired': 2}
    assert [item['course_name'] for item in payload['items']] == ['NR33', 'NR10', 'NR35']
    assert payload['items'][0]['days_until_expiration'] < payload['items'][1]['days_until_expiration']
    assert all(item['employee_name'] == 'Colaborador Ativo' for item in payload['items'])


@pytest.mark.parametrize('role', ['admin', 'seguranca_trabalho', 'almoxarifado', 'gestor', 'rh', 'almoxarifado:balcao_jac'])
def test_course_alerts_permissions(client, role):
    assert client.get('/api/alerts/courses', headers=auth_headers(role)).status_code == 200


def test_course_alerts_require_authentication(client):
    assert client.get('/api/alerts/courses').status_code == 401
