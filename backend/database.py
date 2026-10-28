from motor.motor_asyncio import AsyncIOMotorClient
from pymongo import IndexModel, ASCENDING
import os
from pathlib import Path
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

MONGO_URL = os.environ.get('MONGO_URL')
DB_NAME = os.environ.get('DB_NAME', 'gestorepi_dev')

client = None
db = None

async def connect_db():
    global client, db
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    await create_indexes()
    return db

async def close_db():
    global client
    if client:
        client.close()

async def get_db():
    global db
    if db is None:
        await connect_db()
    return db

async def create_indexes():
    global db
    
    # Users indexes
    await db.users.create_indexes([
        IndexModel([("username", ASCENDING)], unique=True),
        IndexModel([("email", ASCENDING)], unique=True)
    ])
    
    # Employees indexes
    await db.employees.create_indexes([
        IndexModel([("cpf", ASCENDING)], unique=True),
        IndexModel([("full_name", ASCENDING)]),
        IndexModel([("status", ASCENDING)]),
        IndexModel([("department", ASCENDING)])
    ])
    
    # Companies indexes
    await db.companies.create_indexes([
        IndexModel([("cnpj", ASCENDING)], unique=True)
    ])
    
    # EPIs indexes
    await db.epis.create_indexes([
        IndexModel([("ca_number", ASCENDING)]),
        IndexModel([("internal_code", ASCENDING)], unique=True, partialFilterExpression={"internal_code": {"$type": "string"}}),
        IndexModel([("qr_code", ASCENDING)], unique=True, partialFilterExpression={"qr_code": {"$type": "string"}})
    ])

    await db.epi_variations.create_indexes([
        IndexModel([("epi_id", ASCENDING)]),
        IndexModel([("epi_id", ASCENDING), ("status", ASCENDING), ("size", ASCENDING)]),
        IndexModel([("ca_number", ASCENDING)]),
        IndexModel([("supplier_id", ASCENDING)]),
        IndexModel([("size", ASCENDING)]),
        IndexModel([("batch", ASCENDING)]),
        IndexModel([("internal_code", ASCENDING)], unique=True, partialFilterExpression={"internal_code": {"$type": "string"}}),
        IndexModel([("qr_code", ASCENDING)], unique=True, partialFilterExpression={"qr_code": {"$type": "string"}})
    ])
    
    # Tools indexes
    await db.tools.create_indexes([
        IndexModel([("serial_number", ASCENDING)], unique=True, partialFilterExpression={"serial_number": {"$type": "string"}}),
        IndexModel([("internal_code", ASCENDING)], unique=True, partialFilterExpression={"internal_code": {"$type": "string"}}),
        IndexModel([("qr_code", ASCENDING)], unique=True, partialFilterExpression={"qr_code": {"$type": "string"}})
    ])
    
    # Suppliers indexes
    await db.suppliers.create_indexes([
        IndexModel([("cnpj", ASCENDING)], unique=True, partialFilterExpression={"cnpj": {"$type": "string"}})
    ])

    # Courses indexes
    await db.courses.create_indexes([
        IndexModel([("name_normalized", ASCENDING)], unique=True),
        IndexModel([("active", ASCENDING)])
    ])

    await db.course_epi_links.create_indexes([
        IndexModel([("course_id", ASCENDING)]),
        IndexModel([("epi_id", ASCENDING)]),
        IndexModel([("course_id", ASCENDING), ("epi_id", ASCENDING)], unique=True)
    ])


    await db.employee_courses.create_indexes([
        IndexModel([("employee_id", ASCENDING)]),
        IndexModel([("course_id", ASCENDING)]),
        IndexModel([("expiration_date", ASCENDING)]),
        IndexModel([("active", ASCENDING)]),
        IndexModel([("active", ASCENDING), ("expiration_date", ASCENDING)]),
        IndexModel([("employee_id", ASCENDING), ("course_id", ASCENDING)]),
        IndexModel([("employee_id", ASCENDING), ("active", ASCENDING), ("expiration_date", ASCENDING)])
    ])

    await db.facial_templates.create_indexes([
        IndexModel([("employee_id", ASCENDING)]),
        IndexModel([("employee_id", ASCENDING), ("created_at", ASCENDING)])
    ])

    await db.deliveries.create_indexes([
        IndexModel([("employee_id", ASCENDING)]),
        IndexModel([("created_at", ASCENDING)]),
        IndexModel([("employee_id", ASCENDING), ("created_at", ASCENDING)]),
        IndexModel([("is_return", ASCENDING), ("created_at", ASCENDING)])
    ])

    await db.stock_movements.create_indexes([
        IndexModel([("epi_id", ASCENDING)]),
        IndexModel([("created_at", ASCENDING)]),
        IndexModel([("epi_id", ASCENDING), ("created_at", ASCENDING)])
    ])

    await db.kits.create_indexes([
        IndexModel([("sector", ASCENDING)]),
        IndexModel([("sector", ASCENDING), ("is_mandatory", ASCENDING)]),
        IndexModel([("items.epi_group_key", ASCENDING)])
    ])
