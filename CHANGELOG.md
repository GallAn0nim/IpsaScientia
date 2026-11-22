# Changelog

This project follows [semantic versioning](https://semver.org).

## Unreleased

- The fact base grows from 40 facts in eight categories to 892 facts in eighteen. New categories: modern discoveries, cryptography and security, famous bugs and failures, algorithms and complexity, physics, the human mind and perception, chemistry and materials, games and strategy, inventions and discoveries, and Earth and its extremes.
- "I need to check it" is now **I didn't know** (hotkey `d`), and the To check list and counter are now **Didn't know**.
- "Checked" is now **Looked it up** on the list and **Looked up** in the stats.
- The Didn't know list, its counters and what became of each fact are stored under new names. What 0.1.0 saved is moved over at session start, so nothing is lost: facts you looked up still never come back.

## 0.1.0

First release.

- One fact above the prompt during a longer turn: after 30 s of a running turn, at most every 20 minutes across all sessions, at most 12 a day, one per turn.
- Fact card with I knew it (`k`), I need to check it (`c`) and Copy (`y`), in the terminal and the desktop app. It hides 15 s after the turn ends.
- Shuffle bag over the enabled categories: every fact once before any repeats; known facts never return.
- Side panel: on/off with timed pauses, Today and All time stats, the To check list with sources, settings, and the fact base by category.
- AI facts about the current project (off by default), with four AI context levels, a daily cap and a fallback to the fact base.
- Your own facts in `~/.claude/ipsa-scientia/facts.json`, merged at session start.
- Fact base in `data/facts.json` with a checker, `scripts/check-facts.mjs`.
