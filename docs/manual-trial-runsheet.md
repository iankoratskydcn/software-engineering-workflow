# Manual trial: one 1+2 block

Purpose: live the cadence once, by hand, before building more of it. You are the human; your
Claude and Hermes sessions are the fleet. Nothing here needs the review screen, blocker
pings, or committed features, because those do not exist yet. That is part of what the trial
should tell you.

Three hours: one retro/plan hour, then two work hours.

## Before you start

- Open **Software Engineering → Day**. (Or use the CLI: every command below is
  `hermes decision ...`.)
- Pick the work: two small features, each something you could review in about ten
  minutes. Write the criteria for the first one down before the day starts; the retro hour
  is when you ready it.
- Have a timer you trust nearby. The pane counts down, but a second clock shows you what
  you felt.

## Start

1. Enter **3** hours. The layout reads `1+2`. Press **Start day**.
2. Press **Offline** to go **Online**. Standups only run while you are online, and the
   switch turns itself off after an hour without interaction.
3. Pick a hat (Spec, Review, Decide, Retro) whenever you change what you are doing. Each
   switch is logged with the hour you were in, so the retro can see where the time went.

## The clock

Work hour:

| Minute | Ceremony | You | The fleet |
|---|---|---|---|
| :00-:05 | Sprint planning | Commit this hour's Ready feature | Start building |
| :05-:35 | Refinement | Refine the next feature to Ready | Build |
| :35-:50 | Review | Review and accept or reject the previous hour's work | Build |
| :50-:55 | Decision sweep | Clear pending decision cards | Build |
| :55-:60 | Mini retro | Log estimate against actual, mark carryovers | |

Retro hour: `:00-:25` review the log, `:25-:40` decide process changes, `:40-:50` plan the
block, `:50-:60` ready the first feature. The first retro of the trial has no previous block
to read, so spend it on planning and on getting feature 1 to Ready.

Standups arrive every 20 minutes during work hours (minutes 60, 80, 100, ...) and never
during a retro hour.

## What to record

Use the observation log for anything the pane does not record for you. It is append-only;
to correct an entry, add a new one with `--supersedes <id>`.

```
hermes decision observe add --kind estimate_actual --author human \
  --data '{"estimate": 3, "accepted": 1, "carried": false, "review_minutes": 12}' --feature-id <name>
hermes decision observe add --kind carryover --author human --data '{"estimate": 3, "hours_used": 1}' --feature-id <name>
hermes decision observe add --kind note --author human --data '{"text": "agent needed X and I had not said it"}'
```

Notes worth taking as they happen: every time an agent stopped to ask you something the spec
should have answered; every time a review took longer than the ten minutes you planned; every
time you wanted a screen that is not there.

## End

1. In the last retro-style minutes of the final hour, record the decisions you made as
   `process_change` entries and what you noticed as `retro_finding` entries.
2. Press **End day**.
3. Check the log: `hermes decision observe verify`, then `hermes decision observe list`.
4. Confirm it: `hermes decision issue-token --actor owner`, then
   `hermes decision observe checkpoint --actor-token <token>`.

## Exit criteria

- The log holds the whole block: the day start and end, your hat switches, and the standups.
- The retro produced at least one `process_change`.
- You wrote down which minute-map boundaries felt wrong, so the tables in `day_schedule.py`
  can be adjusted. Slices 3-10 are re-ordered from what you learned, not from the plan.
