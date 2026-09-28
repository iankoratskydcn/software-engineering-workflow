"""Idempotent starter data for the Software Engineering Workflow surfaces."""
from __future__ import annotations

import copy
import json

try:
    from . import db
    from .cli_spec_cmds import _DEMO_MINDMAP, _seed_demo_node
except ImportError:
    import db  # type: ignore
    from cli_spec_cmds import _DEMO_MINDMAP, _seed_demo_node  # type: ignore


def _first(conn, table, project_id, title_column, title):
    return conn.execute(
        f"SELECT * FROM {table} WHERE project_id = ? AND {title_column} = ? ORDER BY id LIMIT 1",
        (project_id, title),
    ).fetchone()


def _story_id(tree):
    if not tree:
        return None
    if tree.get("kind") == "story":
        return tree["id"]
    for child in tree.get("children", []):
        found = _story_id(child)
        if found:
            return found
    return None


def seed_starter_workflow(conn, project_id: str, root_title: str | None = None) -> dict:
    project_id = db._spec_project(project_id)
    root = db.get_spec_tree(conn, project_id=project_id)
    if root is None:
        demo = copy.deepcopy(_DEMO_MINDMAP)
        if root_title and root_title.strip():
            demo["title"] = root_title.strip()
        _seed_demo_node(db, conn, project_id, demo)
        root = db.get_spec_tree(conn, project_id=project_id)
    elif root_title and root_title.strip() and root.get("title") == _DEMO_MINDMAP["title"]:
        root = db.update_spec_node(conn, root["id"], project_id=project_id, title=root_title.strip())
    story_id = _story_id(root)

    flow = _first(conn, "flows", project_id, "name", "Request lifecycle")
    if flow is None:
        flow = db.create_flow(conn, project_id=project_id, name="Request lifecycle")
        db.set_flow_steps(conn, flow["id"], project_id=project_id, steps=[
            {"id": "capture", "label": "Capture requirement", "next": ["decide"]},
            {"id": "decide", "label": "Resolve decision", "next": ["build"]},
            {"id": "build", "label": "Build and verify", "next": []},
        ])

    diagram = _first(conn, "architecture_diagrams", project_id, "title", "Workflow architecture")
    if diagram is None:
        diagram = db.add_diagram(
            conn, project_id=project_id, title="Workflow architecture",
            nodes=[
                {"id": "hud", "label": "Software Engineering HUD", "x": 0, "y": 0},
                {"id": "cli", "label": "Project-scoped CLI", "x": 260, "y": 0},
                {"id": "db", "label": "SQLite authority", "x": 520, "y": 0},
            ],
            edges=[{"source": "hud", "target": "cli"}, {"source": "cli", "target": "db"}],
        )

    risk = _first(conn, "risks", project_id, "title", "Unscoped workflow mutations")
    if risk is None:
        risk = db.add_risk(
            conn, project_id=project_id, title="Unscoped workflow mutations",
            description="A surface writes without an explicit project scope.",
            breaks_when="A user switches boards or projects.", status="open",
        )

    tradeoff = _first(conn, "tradeoffs", project_id, "title", "Fast delivery vs. verification")
    if tradeoff is None:
        tradeoff = db.add_tradeoff(
            conn, project_id=project_id, kind="scale",
            title="Fast delivery vs. verification", choice="Verify the vertical slice first",
            alt_label="Ship every surface immediately", cost="slower first slice", gain="less rework",
        )

    lane = _first(conn, "roadmap_lanes", project_id, "title", "Now")
    if lane is None:
        lane = db.create_roadmap_lane(conn, project_id=project_id, title="Now", sort_order=0)
    item = conn.execute(
        "SELECT * FROM roadmap_items WHERE project_id = ? AND title = ? ORDER BY id LIMIT 1",
        (project_id, "Prove the workflow vertical slice"),
    ).fetchone()
    if item is None:
        item = db.create_roadmap_item(
            conn, project_id=project_id, lane_id=lane["id"],
            title="Prove the workflow vertical slice",
            description="Use the MindMap, decision, roadmap, and verification surfaces together.",
            status="in_progress", sort_order=0,
        )

    planning = None
    if story_id:
        planning = conn.execute(
            "SELECT * FROM planning_items WHERE project_id = ? AND title = ? ORDER BY id LIMIT 1",
            (project_id, "Implement the workflow vertical slice"),
        ).fetchone()
        if planning is None:
            planning = db.create_planning_item(
                conn, project_id=project_id, spec_node_id=story_id,
                title="Implement the workflow vertical slice", status="ready", estimate=3, sprint=1,
            )

    return {
        "project_id": project_id,
        "root_id": root["id"] if root else None,
        "story_id": story_id,
        "flow_id": flow["id"],
        "diagram_id": diagram["id"],
        "risk_id": risk["id"],
        "tradeoff_id": tradeoff["id"],
        "roadmap_lane_id": lane["id"],
        "roadmap_item_id": item["id"],
        "planning_item_id": planning["id"] if planning else None,
    }


def _cmd_workflow_seed_demo(args):
    connection = db.connect()
    try:
        result = seed_starter_workflow(connection, args.project_id, args.root_title)
        print(json.dumps({"ok": True, "starter_workflow": result}))
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
