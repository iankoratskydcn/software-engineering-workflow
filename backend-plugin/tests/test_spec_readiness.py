"""Spec nodes: Kanban link, estimate, and the Definition of Ready (schema v16)."""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import cli  # noqa: E402
import db  # noqa: E402

CRITERIA = json.dumps(["Login succeeds", "Wrong password is rejected"])


# --- pure: spec_readiness ------------------------------------------------------------

def readiness(kind="feature", criteria=CRITERIA, estimate=3):
    return db.spec_readiness(kind=kind, criteria_json=criteria, estimate=estimate)


def failed(result):
    return [c["name"] for c in result["checks"] if not c["passed"]]


@pytest.mark.parametrize("kind", ["theme", "epic"])
def test_themes_and_epics_are_not_units_of_work(kind):
    assert readiness(kind=kind, criteria=None, estimate=None) == {"applies": False, "ready": True, "checks": []}


@pytest.mark.parametrize("kind", ["feature", "story"])
def test_a_feature_or_story_with_criteria_and_a_fitting_estimate_is_ready(kind):
    result = readiness(kind=kind)
    assert result["applies"] and result["ready"] and failed(result) == []
    assert [c["name"] for c in result["checks"]] == ["criteria", "estimate", "size"]


@pytest.mark.parametrize("criteria", [None, "", "[]", "not json", '"just a string"', '{"a": 1}', '["ok", ""]', '["ok", "  "]', "[1, 2]"])
def test_unusable_criteria_fail_the_criteria_check(criteria):
    result = readiness(criteria=criteria)
    assert failed(result) == ["criteria"] and not result["ready"]


def test_a_missing_estimate_fails_once_and_skips_the_size_check():
    result = readiness(estimate=None)
    assert failed(result) == ["estimate"]
    assert [c["name"] for c in result["checks"]] == ["criteria", "estimate"]


@pytest.mark.parametrize("estimate, fits", [(1, True), (3, True), (5, True), (8, False), (13, False)])
def test_the_size_rule_is_five_points_for_one_hour(estimate, fits):
    result = readiness(estimate=estimate)
    assert result["ready"] is fits
    assert failed(result) == ([] if fits else ["size"])
    if not fits:
        assert "split it" in result["checks"][-1]["detail"]


def test_everything_missing_reports_every_failure():
    assert failed(readiness(criteria=None, estimate=None)) == ["criteria", "estimate"]
    assert failed(readiness(criteria="[]", estimate=13)) == ["criteria", "size"]


# --- database ---------------------------------------------------------------------------

@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "_hermes_home", lambda: tmp_path)
    projects = sqlite3.connect(tmp_path / "projects.db")
    projects.execute("CREATE TABLE projects (id TEXT PRIMARY KEY, slug TEXT, name TEXT, archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0)")
    projects.executemany("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)", [("p_1", "demo", "Demo"), ("p_2", "other", "Other")])
    projects.commit()
    projects.close()
    connection = db.connect()
    yield connection
    connection.close()


def make_feature(conn, project="p_1", title="Login", **fields):
    root = db.get_spec_tree(conn, project_id=project)
    if root is None:
        root = db.create_spec_node(conn, project_id=project, kind="theme", title="Product")
    epic = db.create_spec_node(conn, project_id=project, kind="epic", title=f"Epic for {title}", parent_id=root["id"])
    node = db.create_spec_node(conn, project_id=project, kind="feature", title=title, parent_id=epic["id"])
    return db.update_spec_node(conn, node["id"], project_id=project, **fields) if fields else node


def test_new_nodes_have_no_link_or_estimate(conn):
    node = make_feature(conn)
    assert node["kanban_task_id"] is None and node["estimate"] is None


@pytest.mark.parametrize("bad", [0, 4, 7, 14, -1, True, "5", 5.0, 5.5])
def test_estimate_must_be_a_point_value(conn, bad):
    node = make_feature(conn)
    with pytest.raises(db.BoundaryError) as error:
        db.update_spec_node(conn, node["id"], project_id="p_1", estimate=bad)
    assert error.value.code == "invalid_input"


def test_estimate_can_be_set_and_cleared(conn):
    node = make_feature(conn)
    assert db.update_spec_node(conn, node["id"], project_id="p_1", estimate=8)["estimate"] == 8
    assert db.update_spec_node(conn, node["id"], project_id="p_1", estimate=None)["estimate"] is None


def test_the_database_itself_refuses_a_bad_estimate(conn):
    node = make_feature(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE spec_nodes SET estimate = 4 WHERE id = ?", (node["id"],))


def test_a_card_links_to_one_node_per_project(conn):
    first = make_feature(conn, title="Login", kanban_task_id="t_1")
    second = make_feature(conn, title="Billing")
    assert first["kanban_task_id"] == "t_1"

    with pytest.raises(db.BoundaryError) as error:
        db.update_spec_node(conn, second["id"], project_id="p_1", kanban_task_id="t_1")
    assert error.value.code == "conflict" and "Login" in str(error.value)

    other_project = make_feature(conn, project="p_2", title="Elsewhere")
    assert db.update_spec_node(conn, other_project["id"], project_id="p_2", kanban_task_id="t_1")["kanban_task_id"] == "t_1"


def test_a_link_can_be_moved_and_cleared_and_relinking_the_same_node_is_fine(conn):
    node = make_feature(conn, kanban_task_id="t_1")
    assert db.update_spec_node(conn, node["id"], project_id="p_1", kanban_task_id="t_1")["kanban_task_id"] == "t_1"
    assert db.update_spec_node(conn, node["id"], project_id="p_1", kanban_task_id="t_2")["kanban_task_id"] == "t_2"
    assert db.update_spec_node(conn, node["id"], project_id="p_1", kanban_task_id=None)["kanban_task_id"] is None
    other = make_feature(conn, title="Billing")
    assert db.update_spec_node(conn, other["id"], project_id="p_1", kanban_task_id="t_1")["kanban_task_id"] == "t_1"


def test_a_draft_feature_cannot_become_ready_until_it_passes(conn):
    node = make_feature(conn)
    with pytest.raises(db.BoundaryError) as error:
        db.update_spec_node(conn, node["id"], project_id="p_1", status="ready")
    assert error.value.code == "constraint"
    assert "criteria: needs at least one acceptance criterion" in str(error.value)
    assert "estimate: needs an estimate" in str(error.value)
    assert db.get_spec_tree(conn, project_id="p_1")["children"][0]["children"][0]["status"] == "draft"


def test_too_big_a_feature_is_refused_with_the_reason(conn):
    node = make_feature(conn, criteria_json=CRITERIA, estimate=13)
    with pytest.raises(db.BoundaryError, match="13 points is too big for one hour"):
        db.update_spec_node(conn, node["id"], project_id="p_1", status="ready")


def test_the_gate_uses_the_values_being_set_in_the_same_update(conn):
    node = make_feature(conn)
    ready = db.update_spec_node(conn, node["id"], project_id="p_1", criteria_json=CRITERIA, estimate=3, status="ready")
    assert ready["status"] == "ready"


def test_only_the_move_into_ready_is_gated(conn):
    node = make_feature(conn, criteria_json=CRITERIA, estimate=3, status="ready")
    assert db.update_spec_node(conn, node["id"], project_id="p_1", note="edited")["note"] == "edited"
    assert db.update_spec_node(conn, node["id"], project_id="p_1", status="ready")["status"] == "ready"
    drafted = db.update_spec_node(conn, node["id"], project_id="p_1", status="draft", estimate=None)
    assert drafted["status"] == "draft"


def test_themes_and_epics_can_be_marked_ready_without_criteria(conn):
    root = db.create_spec_node(conn, project_id="p_1", kind="theme", title="Product")
    assert db.update_spec_node(conn, root["id"], project_id="p_1", status="ready")["status"] == "ready"


def test_node_readiness_reads_the_stored_node(conn):
    node = make_feature(conn)
    assert failed(db.spec_node_readiness(conn, node["id"], project_id="p_1")) == ["criteria", "estimate"]
    db.update_spec_node(conn, node["id"], project_id="p_1", criteria_json=CRITERIA, estimate=2)
    assert db.spec_node_readiness(conn, node["id"])["ready"] is True
    with pytest.raises(db.BoundaryError) as error:
        db.spec_node_readiness(conn, node["id"], project_id="p_2")
    assert error.value.code == "not_found"


def test_the_tree_carries_the_new_fields(conn):
    make_feature(conn, kanban_task_id="t_9", estimate=5)
    feature = db.get_spec_tree(conn, project_id="p_1")["children"][0]["children"][0]
    assert (feature["kanban_task_id"], feature["estimate"]) == ("t_9", 5)


# --- migration -------------------------------------------------------------------------------

def test_a_v15_database_upgrades_keeping_its_nodes_and_reruns_without_change(conn):
    node = make_feature(conn, kanban_task_id="t_1", estimate=3)
    conn.execute("DROP INDEX idx_spec_nodes_kanban_task")
    conn.execute("ALTER TABLE spec_nodes DROP COLUMN kanban_task_id")
    conn.execute("ALTER TABLE spec_nodes DROP COLUMN estimate")
    conn.execute("PRAGMA user_version = 15")
    conn.commit()

    db.init_db(conn)
    columns = {row[1] for row in conn.execute("PRAGMA table_info(spec_nodes)")}
    assert {"kanban_task_id", "estimate"} <= columns
    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.LATEST_SCHEMA_VERSION
    row = conn.execute("SELECT title, kanban_task_id, estimate FROM spec_nodes WHERE id = ?", (node["id"],)).fetchone()
    assert (row["title"], row["kanban_task_id"], row["estimate"]) == ("Login", None, None)  # the old node survives, unlinked

    before = "\n".join(conn.iterdump())
    db.init_db(conn)
    assert "\n".join(conn.iterdump()) == before


# --- CLI -----------------------------------------------------------------------------------------

def run(capsys, *argv):
    parser = argparse.ArgumentParser()
    cli.setup(parser)
    args = parser.parse_args(["spec", *argv])
    code = 0
    try:
        args.func(args)
    except SystemExit as exit_:
        code = exit_.code
    return code, json.loads(capsys.readouterr().out)


def test_cli_links_unlinks_estimates_checks_and_gates(conn, capsys):
    node = make_feature(conn)
    base = ["--project-id", "p_1", "--id", node["id"]]

    code, out = run(capsys, "check-ready", *base)
    assert code == 0 and out["readiness"]["ready"] is False and out["node_id"] == node["id"]

    code, out = run(capsys, "update-node", *base, "--status", "ready")
    assert code == 6 and out["error"]["code"] == "constraint" and "not ready" in out["error"]["message"]

    assert run(capsys, "set-criteria", *base, "--criteria-json", CRITERIA)[0] == 0
    assert run(capsys, "update-node", *base, "--estimate", "3")[1]["node"]["estimate"] == 3
    assert run(capsys, "check-ready", *base)[1]["readiness"]["ready"] is True
    assert run(capsys, "update-node", *base, "--status", "ready")[1]["node"]["status"] == "ready"

    code, out = run(capsys, "link-kanban", *base, "--task-id", "t_42")
    assert code == 0 and out["node"]["kanban_task_id"] == "t_42"
    listed = next(n for n in run(capsys, "list", "--project-id", "p_1")[1]["nodes"] if n["id"] == node["id"])
    assert (listed["kanban_task_id"], listed["estimate"]) == ("t_42", 3)

    code, out = run(capsys, "link-kanban", *base, "--task-id", "")
    assert code == 0 and out["node"]["kanban_task_id"] is None


def test_cli_reports_a_link_conflict_and_a_bad_estimate(conn, capsys):
    first = make_feature(conn, title="Login", kanban_task_id="t_1")
    second = make_feature(conn, title="Billing")
    code, out = run(capsys, "link-kanban", "--project-id", "p_1", "--id", second["id"], "--task-id", "t_1")
    assert code == 4 and out["error"]["code"] == "conflict" and first["id"] in out["error"]["message"]

    base = ["--project-id", "p_1", "--id", second["id"]]
    assert run(capsys, "update-node", *base, "--estimate", "5")[1]["node"]["estimate"] == 5
    assert run(capsys, "update-node", *base, "--clear-estimate")[1]["node"]["estimate"] is None

    code, out = run(capsys, "update-node", "--project-id", "p_1", "--id", second["id"], "--estimate", "4")
    assert code == 2 and out["error"]["code"] == "invalid_input"
    code, out = run(capsys, "check-ready", "--project-id", "p_1", "--id", "sn_missing")
    assert code == 3 and out["error"]["code"] == "not_found"
