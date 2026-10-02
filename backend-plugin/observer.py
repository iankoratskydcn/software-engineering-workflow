"""The Observer's report: pure functions, no I/O and no clock.

A standup is a deterministic snapshot of how the hour is going: where the clock
is, the state of every Kanban board, how many decisions are waiting, what the
human did since the last standup, and a short list of what needs attention.
Nothing here decides, dispatches, or changes anything.

Limits worth knowing: Kanban gives states, not timestamps, so "progress" is
the change in each board's counts since the previous standup. Which cards
belong to which feature is not known until cards are linked to spec nodes, so
the report is per board, not per feature.
"""

from __future__ import annotations

import math
from typing import Optional

STANDUP_SECONDS = 20 * 60
KANBAN_STATUSES = ("triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done")
MAX_LISTED_BLOCKED = 5
MAX_ATTENTION_TITLES = 3
WRAP_UP_MINUTES = 10


def standup_slot(day_start_ts: float, now_ts: float) -> int:
    """Which 20-minute slot of the day `now_ts` falls in (slot 0 is the first
    twenty minutes). Hour 1 of every block is a retro hour, so the first
    standup of a day is the one at minute 60, the start of the first work hour."""
    return max(0, math.floor((now_ts - day_start_ts) / STANDUP_SECONDS))


def parse_tasks(value) -> list[dict]:
    """Tasks from a `kanban list --json` payload: a list, or a dict wrapping one."""
    if isinstance(value, dict):
        for key in ("tasks", "items", "rows"):
            if isinstance(value.get(key), list):
                value = value[key]
                break
    return [task for task in value if isinstance(task, dict)] if isinstance(value, list) else []


def summarize_kanban(boards: list[dict]) -> dict:
    """Counts per status for each board and in total. `boards` is
    [{"board": slug, "tasks": [{"id", "title", "status"}, ...]}]; archived
    tasks are ignored and a task with no usable status counts as "unknown"."""
    summarized = []
    totals: dict[str, int] = {}
    for board in boards:
        counts: dict[str, int] = {}
        blocked = []
        for task in board.get("tasks", []):
            status = task.get("status") if task.get("status") in KANBAN_STATUSES + ("archived",) else "unknown"
            if status == "archived":
                continue
            counts[status] = counts.get(status, 0) + 1
            totals[status] = totals.get(status, 0) + 1
            if status == "blocked" and len(blocked) < MAX_LISTED_BLOCKED:
                blocked.append({"id": task.get("id"), "title": task.get("title")})
        summarized.append({"board": board.get("board"), "counts": counts, "blocked": blocked})
    return {"boards": summarized, "totals": totals}


def kanban_delta(current: dict, previous: Optional[dict]) -> dict:
    """Non-zero change per status since the previous standup (empty if none)."""
    if previous is None:
        return {}
    statuses = set(current) | set(previous)
    return {s: current.get(s, 0) - previous.get(s, 0) for s in sorted(statuses) if current.get(s, 0) != previous.get(s, 0)}


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" + ("" if count == 1 else "s")


def attention(*, kanban: dict, decisions: dict, minutes_left: int, hour_kind: str, delta: dict) -> list[str]:
    """What the human should look at, most urgent first. Empty means nothing."""
    items: list[str] = []
    if not kanban["available"]:
        items.append(f"Kanban could not be read: {kanban.get('error') or 'unknown error'}")
    blocked = kanban.get("totals", {}).get("blocked", 0)
    if blocked:
        titles = [t["title"] for b in kanban["boards"] for t in b["blocked"] if t.get("title")][:MAX_ATTENTION_TITLES]
        suffix = f": {'; '.join(titles)}" if titles else ""
        items.append(f"{_plural(blocked, 'task')} blocked{suffix}")
    if decisions["urgent"]:
        items.append(f"{_plural(decisions['urgent'], 'urgent decision')} waiting")
    if decisions["pending"] > decisions["urgent"]:
        items.append(f"{_plural(decisions['pending'] - decisions['urgent'], 'decision')} pending")
    if hour_kind == "work" and minutes_left <= WRAP_UP_MINUTES:
        items.append(f"{_plural(minutes_left, 'minute')} left in this hour")
    moved = {status: change for status, change in delta.items() if status in ("done", "review") and change > 0}
    for status, change in moved.items():
        items.append(f"Since the last standup: +{change} {status}")
    return items


def build_report(
    *, slot: int, day: str, current: dict, kanban_boards: dict, decisions: dict,
    since_last: dict, current_hat: Optional[str], previous_totals: Optional[dict], now_ts: float,
) -> dict:
    """Assemble the standup. `current` is the running hour from
    day_schedule.snapshot (with its phase); `kanban_boards` is the reader's
    {"available", "error", "boards"}; `decisions` is {"pending", "urgent"};
    `since_last` is {"records", "by_kind"}."""
    phase = current["phase"]
    minutes_elapsed = int((now_ts - current["start_ts"]) // 60)
    minutes_left = max(0, 60 - minutes_elapsed)
    if kanban_boards["available"]:
        summary = summarize_kanban(kanban_boards["boards"])
    else:
        summary = {"boards": [], "totals": {}}
    kanban = {"available": kanban_boards["available"], "error": kanban_boards.get("error"), **summary}
    delta = kanban_delta(summary["totals"], previous_totals) if kanban["available"] else {}
    return {
        "slot": slot,
        "day": day,
        "block": current["block"],
        "hour": current["hour"],
        "hour_kind": current["kind"],
        "ceremony": phase["ceremony"],
        "minutes_elapsed": minutes_elapsed,
        "minutes_left": minutes_left,
        "kanban": kanban,
        "kanban_delta": delta,
        "decisions": decisions,
        "since_last": since_last,
        "current_hat": current_hat,
        "attention": attention(
            kanban=kanban, decisions=decisions, minutes_left=minutes_left, hour_kind=current["kind"], delta=delta,
        ),
    }
