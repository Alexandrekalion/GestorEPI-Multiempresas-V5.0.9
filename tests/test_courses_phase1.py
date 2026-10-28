import sys
from pathlib import Path

import pytest
from bson import ObjectId
from fastapi import HTTPException, Request, status
from fastapi.testclient import TestClient
from pymongo.errors import DuplicateKeyError


BACKEND_DIR = Path(__file__).resolve().parents[1] / "backend"
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import server as backend_server  # noqa: E402


class FakeCursor:
    def __init__(self, documents):
        self.documents = list(documents)

    def sort(self, field_name, direction):
        reverse = direction == -1
        self.documents.sort(key=lambda item: item.get(field_name) or "", reverse=reverse)
        return self

    async def to_list(self, limit):
        return self.documents[:limit]


class FakeInsertOneResult:
    def __init__(self, inserted_id):
        self.inserted_id = inserted_id


class FakeInsertManyResult:
    def __init__(self, inserted_ids):
        self.inserted_ids = inserted_ids


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
                if "$ne" in expected and actual == expected["$ne"]:
                    return False
                continue
            if actual != expected:
                return False
        return True

    def find(self, query=None):
        return FakeCursor([doc for doc in self.documents if self._matches(doc, query or {})])

    async def find_one(self, query):
        for document in self.documents:
            if self._matches(document, query):
                return dict(document)
        return None

    async def insert_one(self, document):
        if "name_normalized" in document:
            for existing in self.documents:
                if existing.get("name_normalized") == document.get("name_normalized"):
                    raise DuplicateKeyError("duplicate course")
        if "course_id" in document and "epi_id" in document:
            for existing in self.documents:
                if existing.get("course_id") == document.get("course_id") and existing.get("epi_id") == document.get("epi_id"):
                    raise DuplicateKeyError("duplicate course_epi_link")
        stored = dict(document)
        stored["_id"] = stored.get("_id", ObjectId())
        self.documents.append(stored)
        return FakeInsertOneResult(stored["_id"])

    async def insert_many(self, documents):
        inserted_ids = []
        for document in documents:
            result = await self.insert_one(document)
            inserted_ids.append(result.inserted_id)
        return FakeInsertManyResult(inserted_ids)

    async def update_one(self, query, update):
        for index, document in enumerate(self.documents):
            if self._matches(document, query):
                updated = dict(document)
                updated.update(update.get("$set", {}))
                if "name_normalized" in updated:
                    for other in self.documents:
                        if other.get("_id") != document.get("_id") and other.get("name_normalized") == updated.get("name_normalized"):
                            raise DuplicateKeyError("duplicate course")
                self.documents[index] = updated
                return FakeUpdateResult(1)
        return FakeUpdateResult(0)

    async def delete_many(self, query):
        original_count = len(self.documents)
        self.documents = [doc for doc in self.documents if not self._matches(doc, query)]
        return FakeDeleteResult(original_count - len(self.documents))

    async def delete_one(self, query):
        for index, document in enumerate(self.documents):
            if self._matches(document, query):
                self.documents.pop(index)
                return FakeDeleteResult(1)
        return FakeDeleteResult(0)


class FakeDB:
    def __init__(self):
        epi_1 = {"_id": ObjectId(), "name": "Capacete Classe B", "category": "Cabeca", "type_category": "Cabeca"}
        epi_2 = {"_id": ObjectId(), "name": "Cinto Paraquedista", "category": "Altura", "type_category": "Altura"}
        self.epis = FakeCollection([epi_1, epi_2])
        self.courses = FakeCollection([])
        self.course_epi_links = FakeCollection([])


@pytest.fixture
def client(monkeypatch):
    fake_db = FakeDB()

    async def fake_get_db():
        return fake_db

    async def fake_get_current_user(request: Request):
        header = request.headers.get("Authorization")
        if not header or not header.startswith("Bearer "):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Credenciais inválidas",
                headers={"WWW-Authenticate": "Bearer"},
            )
        role = header.replace("Bearer ", "").strip()
        return {
            "id": "user-1",
            "username": role,
            "email": f"{role}@teste.local",
            "role": role,
            "is_active": True,
        }

    monkeypatch.setattr(backend_server, "get_db", fake_get_db)
    backend_server.app.dependency_overrides[backend_server.get_current_user] = fake_get_current_user
    backend_server.app.router.on_startup.clear()
    backend_server.app.router.on_shutdown.clear()

    with TestClient(backend_server.app) as test_client:
        yield test_client, fake_db

    backend_server.app.dependency_overrides.clear()


def auth_headers(role):
    return {"Authorization": f"Bearer {role}"}


def test_courses_requires_authentication(client):
    test_client, _ = client
    response = test_client.get("/api/courses")
    assert response.status_code == 401


def test_admin_can_create_course_and_link_epis(client):
    test_client, fake_db = client
    epi_ids = [str(doc["_id"]) for doc in fake_db.epis.documents]
    response = test_client.post(
        "/api/courses",
        headers=auth_headers("admin"),
        json={
            "name": " NR35 ",
            "description": " Trabalho em altura ",
            "active": True,
            "block_epi_delivery": True,
            "alert_days_before_expiration": 30,
            "epi_ids": epi_ids,
        },
    )
    assert response.status_code == 201
    payload = response.json()
    assert payload["name"] == "NR35"
    assert payload["description"] == "Trabalho em altura"
    assert payload["linked_epis_count"] == 2


def test_duplicate_course_name_is_blocked_case_and_space_insensitive(client):
    test_client, _ = client
    first = test_client.post(
        "/api/courses",
        headers=auth_headers("seguranca_trabalho"),
        json={"name": "NR35", "block_epi_delivery": False, "alert_days_before_expiration": 0, "active": True, "epi_ids": []},
    )
    assert first.status_code == 201

    duplicate = test_client.post(
        "/api/courses",
        headers=auth_headers("seguranca_trabalho"),
        json={"name": " nr35  ", "block_epi_delivery": False, "alert_days_before_expiration": 0, "active": True, "epi_ids": []},
    )
    assert duplicate.status_code == 409


@pytest.mark.parametrize(
    "payload",
    [
        {"name": "", "block_epi_delivery": False, "alert_days_before_expiration": 0, "active": True, "epi_ids": []},
        {"name": "   ", "block_epi_delivery": False, "alert_days_before_expiration": 0, "active": True, "epi_ids": []},
        {"name": "NR10", "block_epi_delivery": False, "alert_days_before_expiration": -1, "active": True, "epi_ids": []},
        {"name": "NR10", "block_epi_delivery": False, "alert_days_before_expiration": "abc", "active": True, "epi_ids": []},
    ],
)
def test_invalid_course_payloads_fail_validation(client, payload):
    test_client, _ = client
    response = test_client.post("/api/courses", headers=auth_headers("admin"), json=payload)
    assert response.status_code == 422


def test_almox_and_gestor_can_only_read(client):
    test_client, fake_db = client
    epi_id = str(fake_db.epis.documents[0]["_id"])
    created = test_client.post(
        "/api/courses",
        headers=auth_headers("admin"),
        json={"name": "NR18", "block_epi_delivery": False, "alert_days_before_expiration": 0, "active": True, "epi_ids": [epi_id]},
    )
    assert created.status_code == 201
    course_id = created.json()["id"]

    get_almox = test_client.get("/api/courses", headers=auth_headers("almoxarifado"))
    assert get_almox.status_code == 200

    get_gestor = test_client.get(f"/api/courses/{course_id}", headers=auth_headers("gestor"))
    assert get_gestor.status_code == 200
    assert get_gestor.json()["linked_epis_count"] == 1

    post_almox = test_client.post(
        "/api/courses",
        headers=auth_headers("almoxarifado"),
        json={"name": "NR33", "block_epi_delivery": False, "alert_days_before_expiration": 0, "active": True, "epi_ids": []},
    )
    assert post_almox.status_code == 403

    patch_gestor = test_client.patch(
        f"/api/courses/{course_id}",
        headers=auth_headers("gestor"),
        json={"active": False},
    )
    assert patch_gestor.status_code == 403


def test_rh_cannot_access_courses_module(client):
    test_client, _ = client
    response = test_client.get("/api/courses", headers=auth_headers("rh"))
    assert response.status_code == 403


def test_link_endpoint_validates_duplicate_and_missing_epi(client):
    test_client, fake_db = client
    create_course = test_client.post(
        "/api/courses",
        headers=auth_headers("admin"),
        json={"name": "NR12", "block_epi_delivery": False, "alert_days_before_expiration": 0, "active": True, "epi_ids": []},
    )
    assert create_course.status_code == 201
    course_id = create_course.json()["id"]
    epi_id = str(fake_db.epis.documents[0]["_id"])

    create_link = test_client.post(
        f"/api/courses/{course_id}/epis",
        headers=auth_headers("admin"),
        json={"epi_id": epi_id},
    )
    assert create_link.status_code == 201

    duplicate_link = test_client.post(
        f"/api/courses/{course_id}/epis",
        headers=auth_headers("admin"),
        json={"epi_id": epi_id},
    )
    assert duplicate_link.status_code == 409

    missing_epi = test_client.post(
        f"/api/courses/{course_id}/epis",
        headers=auth_headers("admin"),
        json={"epi_id": str(ObjectId())},
    )
    assert missing_epi.status_code == 404


def test_inactive_course_can_keep_links(client):
    test_client, fake_db = client
    epi_id = str(fake_db.epis.documents[0]["_id"])
    created = test_client.post(
        "/api/courses",
        headers=auth_headers("seguranca_trabalho"),
        json={"name": "NR06", "block_epi_delivery": True, "alert_days_before_expiration": 0, "active": True, "epi_ids": [epi_id]},
    )
    course_id = created.json()["id"]

    updated = test_client.patch(
        f"/api/courses/{course_id}",
        headers=auth_headers("seguranca_trabalho"),
        json={"active": False},
    )
    assert updated.status_code == 200
    payload = updated.json()
    assert payload["active"] is False
    assert payload["linked_epis_count"] == 1
