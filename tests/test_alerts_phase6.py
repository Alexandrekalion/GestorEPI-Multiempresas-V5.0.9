import asyncio
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from bson import ObjectId

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


class FakeCollection:
    def __init__(self, documents=None):
        self.documents = [dict(document) for document in (documents or [])]

    def _matches(self, document, query):
        for key, expected in (query or {}).items():
            actual = document.get(key)
            if isinstance(expected, dict):
                if '$ne' in expected and actual == expected['$ne']:
                    return False
                if '$in' in expected and str(actual) not in {str(value) for value in expected['$in']}:
                    return False
                continue
            if str(actual) != str(expected):
                return False
        return True

    def find(self, query=None, projection=None):
        return FakeCursor([document for document in self.documents if self._matches(document, query or {})])

    async def find_one(self, query):
        for document in self.documents:
            if self._matches(document, query or {}):
                return dict(document)
        return None

    async def count_documents(self, query=None):
        return len([document for document in self.documents if self._matches(document, query or {})])

    def aggregate(self, pipeline):
        return FakeCursor([])


class Phase6DB:
    def __init__(self):
        today = datetime.now(timezone.utc)
        self.company_id = ObjectId()
        self.employee_id = ObjectId()
        self.kit_id = ObjectId()
        self.low_epi_id = ObjectId()
        self.zero_epi_id = ObjectId()
        self.ca_expiring_epi_id = ObjectId()
        self.ca_expired_epi_id = ObjectId()
        self.course_id = ObjectId()

        self.companies = FakeCollection([{'_id': self.company_id, 'legal_name': 'Empresa de Teste'}])
        self.employees = FakeCollection([{
            '_id': self.employee_id,
            'full_name': 'Colaborador Ativo',
            'company_id': str(self.company_id),
            'department': 'Montagem',
            'status': 'active',
            'kit_id': str(self.kit_id),
        }])
        self.kits = FakeCollection([{
            '_id': self.kit_id,
            'name': 'Kit Montagem',
            'epis': [{'epi_id': str(self.low_epi_id)}, {'epi_id': str(self.zero_epi_id)}],
        }])
        self.epis = FakeCollection([
            {'_id': self.low_epi_id, 'name': 'Luva', 'current_stock': 99, 'min_stock': 1},
            {'_id': self.zero_epi_id, 'name': 'Capacete', 'current_stock': 99, 'min_stock': 0},
            {'_id': self.ca_expiring_epi_id, 'name': 'Cinto', 'current_stock': 5, 'min_stock': 0},
            {'_id': self.ca_expired_epi_id, 'name': 'Talabarte', 'current_stock': 5, 'min_stock': 0},
        ])
        self.epi_variations = FakeCollection([
            {'_id': ObjectId(), 'epi_id': str(self.low_epi_id), 'current_stock': 1, 'min_stock': 2, 'status': 'ativo', 'size': 'G'},
            {'_id': ObjectId(), 'epi_id': str(self.zero_epi_id), 'current_stock': 0, 'min_stock': 0, 'status': 'ativo', 'size': 'M'},
            {'_id': ObjectId(), 'epi_id': str(self.ca_expiring_epi_id), 'current_stock': 5, 'min_stock': 0, 'status': 'ativo', 'ca_number': '123', 'ca_validity': today + timedelta(days=10)},
            {'_id': ObjectId(), 'epi_id': str(self.ca_expired_epi_id), 'current_stock': 5, 'min_stock': 0, 'status': 'ativo', 'ca_number': '456', 'ca_validity': today - timedelta(days=2)},
        ])
        self.courses = FakeCollection([{'_id': self.course_id, 'name': 'NR35', 'active': True, 'alert_days_before_expiration': 30}])
        self.employee_courses = FakeCollection([{
            '_id': ObjectId(),
            'employee_id': str(self.employee_id),
            'course_id': str(self.course_id),
            'expiration_date': today + timedelta(days=5),
            'active': True,
        }])
        self.deliveries = FakeCollection([])


def run(coro):
    return asyncio.run(coro)


def test_stock_zero_is_critical_even_when_minimum_is_zero_and_variation_is_source():
    db = Phase6DB()
    stock_low, stock_zero, ca_expiring, ca_expired, metadata = run(backend_server.build_stock_and_ca_alerts(db))

    assert [item['epi_name'] for item in stock_low] == ['Luva']
    assert stock_low[0]['current_stock'] == 1
    assert stock_low[0]['min_stock'] == 2
    assert [item['epi_name'] for item in stock_zero] == ['Capacete']
    assert stock_zero[0]['severity'] == 'CRÍTICO'
    assert stock_zero[0]['current_stock'] == 0
    assert stock_zero[0]['min_stock'] == 0
    assert [item['epi_name'] for item in ca_expiring] == ['Cinto']
    assert [item['epi_name'] for item in ca_expired] == ['Talabarte']
    assert metadata['operational_sources'] == 4


def test_alert_center_keeps_stock_alerts_restricted_by_role():
    db = Phase6DB()
    admin_center = run(backend_server.build_alert_center(db, {'role': 'admin'}))
    rh_center = run(backend_server.build_alert_center(db, {'role': 'rh'}))

    assert admin_center['summary']['stock_low'] == 1
    assert admin_center['summary']['stock_zero'] == 1
    assert admin_center['summary']['ca_expiring'] == 1
    assert admin_center['summary']['ca_expired'] == 1
    assert admin_center['summary']['course_expiring'] == 1
    assert admin_center['metadata']['stock_visible'] is True

    assert rh_center['summary']['stock_low'] == 0
    assert rh_center['summary']['stock_zero'] == 0
    assert rh_center['summary']['ca_expiring'] == 0
    assert rh_center['summary']['ca_expired'] == 0
    assert rh_center['summary']['course_expiring'] == 1
    assert rh_center['metadata']['stock_visible'] is False
    assert all(item['type'] not in {'stock_low', 'stock_zero', 'ca_expiring', 'ca_expired'} for item in rh_center['alerts'])
