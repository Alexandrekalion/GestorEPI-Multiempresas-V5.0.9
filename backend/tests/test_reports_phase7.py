import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reporting import _delivery_kind, _facial_status, _group_rows, _report_dt

def test_consumption_grouping_counts_unique_collaborators():
    rows = [
        {'epi_name': 'Luva', 'variation': 'G', 'employee_id': '1', 'quantity': 2},
        {'epi_name': 'Luva', 'variation': 'G', 'employee_id': '1', 'quantity': 3},
        {'epi_name': 'Luva', 'variation': 'G', 'employee_id': '2', 'quantity': 4},
    ]
    grouped = _group_rows(rows, 'epi')
    assert grouped[0]['quantity'] == 9
    assert grouped[0]['collaborators'] == 2
    assert grouped[0]['average'] == 4.5

def test_return_is_identified_and_kit_is_not_inferred_for_individual():
    assert _delivery_kind({'delivery_type': 'individual'}, {'epi_name': 'Luva'}) == 'Individual'
    assert _delivery_kind({'delivery_type': 'kit'}, {'epi_name': 'Luva'}) == 'Kit'
    assert _facial_status({'facial_validation_status': 'validated', 'facial_match_score': 0.91}).startswith('validated')

def test_date_only_end_is_inclusive():
    parsed = _report_dt('2026-09-23', end=True)
    assert parsed == datetime(2026, 9, 23, 23, 59, 59, 999999, tzinfo=timezone.utc)

def test_report_module_is_read_only():
    source = Path(__file__).resolve().parents[1].joinpath('reporting.py').read_text()
    assert '.insert_one' not in source
    assert '.update_one' not in source
    assert '.delete_one' not in source
