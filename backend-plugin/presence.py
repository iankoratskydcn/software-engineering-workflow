"""The online switch: pure rules, no I/O and no clock.

The human turns the switch on by hand. It turns itself off after an hour with
no interaction. The pane sends a heartbeat (`presence touch`) while the human
interacts, and expiry is decided here, once, so every caller agrees on it.

State is a dict {"online": bool, "since": ts, "last_seen": ts} (epoch seconds),
or None when the switch has never been used.
"""

from __future__ import annotations

from typing import Optional

IDLE_SECONDS = 3600


def evaluate(state: Optional[dict], now_ts: float) -> dict:
    """What the stored state means at `now_ts`. `expired` is True when the
    switch is stored as on but has been idle for IDLE_SECONDS or more; the
    effective state is then offline, and `expired_at` is when it should have
    turned off."""
    if not state or not state.get("online"):
        return {"online": False, "since": None, "last_seen": None, "expired": False, "expired_at": None}
    last_seen = state["last_seen"]
    if now_ts - last_seen >= IDLE_SECONDS:
        return {
            "online": False, "since": state["since"], "last_seen": last_seen,
            "expired": True, "expired_at": last_seen + IDLE_SECONDS,
        }
    return {"online": True, "since": state["since"], "last_seen": last_seen, "expired": False, "expired_at": None}


def turned_on(now_ts: float) -> dict:
    return {"online": True, "since": now_ts, "last_seen": now_ts}


def turned_off(state: Optional[dict]) -> dict:
    return {"online": False, "since": None, "last_seen": (state or {}).get("last_seen")}


def touched(state: dict, now_ts: float) -> dict:
    """The state after a heartbeat. Only meaningful while online and unexpired."""
    return {**state, "last_seen": max(state["last_seen"], now_ts)}
