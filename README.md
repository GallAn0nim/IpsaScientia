# Ipsa Scientia

### Your agent is working. Your brain doesn't have to sit idle.

> *Ipsa scientia potestas est.*
> Knowledge itself is power.
> — Francis Bacon, *Meditationes Sacrae*, 1597

You hand Claude a refactor. It says "on it" and starts reading files. You watch the spinner. You watch it some more. Two minutes later you are on your phone, three apps deep, reading about a celebrity you have never heard of, and you have forgotten what the refactor was for.

Bacon said knowledge is power. He never said it had to come from your phone.

**Ipsa Scientia turns the minutes you spend waiting for Claude into one small, true, surprising fact.** Now and then, during a longer turn, one sentence appears above your prompt, like the tips on a game's loading screen:

```
Did you know? · Computer history
In 1947 Harvard Mark II operators taped a moth into their logbook: "First actual case of bug being found." Engineers already said bug long before.
[ I knew it ]  [ I didn't know ]  [ Copy ]
```

You read it in ten seconds and go back to work. You don't leave the session, and it costs Claude nothing: the facts ship with the mod, so it sends nothing to a model and adds nothing to the agent's context.

It is rare on purpose. A fact you see every turn turns into wallpaper; a fact that appears a dozen times a day still gets read.

## What it does

- **One fact during a longer turn.** Only when Claude's turn has run for 30 seconds, at most every 20 minutes (counted across all your open sessions), and at most 12 a day. Short back-and-forth questions never see one. An 8-hour day brings about 10 to 12 facts.
- **Three buttons.** **I knew it** (`k`): the fact never comes back. **I didn't know** (`d`): it goes on your Didn't know list in the panel, with its source link, so you can look it up later. **Copy** (`y`): the fact and its source go to the clipboard, for the colleague who needs to know. Press nothing and the card hides itself 15 seconds after the turn ends.
- **Eight categories:** computer history, programming languages, the internet and the web, math, space, the human body, nature, and words and language (where *bug*, *cookie* and *spam* come from).
- **Every built-in fact has a source**, and every one is checked against it by hand before it ships. No source, no fact. Popular myths appear only to be corrected.
- **AI facts about your project** (off by default). Let Claude write one fact in three about what you are working on: the borrow checker while you edit Rust, the history of regular expressions while you fix one. You choose how much the model sees.
- **Works in the terminal and the desktop app.** Text only, so it draws the same everywhere.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install ipsa-scientia --marketplace GallAn0nim/IpsaScientia
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session, desktop app included).

From a shell:

```bash
claude plugin install ipsa-scientia --marketplace GallAn0nim/IpsaScientia
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `GallAn0nim/IpsaScientia`, then **Add plugin**.

## How it works

1. **A turn starts.** Ipsa Scientia checks whether a fact is due: the mod is on, the last fact (in any session) was at least *Minutes between facts* ago, and today's limit is not used up.
2. **The turn runs on.** If it is still running after *Show after* (30 s), one fact appears above the prompt, in the session whose turn it is. Never more than one per turn.
3. **Picking.** A shuffle bag over the categories you have on: every fact comes up once before any repeats. Facts you knew never return; facts on your Didn't know list stay away while they are there. Once you have seen them all, only the ones you let pass come back.
4. **The turn ends.** The card stays 15 more seconds, then hides and counts as *Ignored*. Any button but Copy closes it at once.

### The panel

Type `/ipsa-scientia` to open the side panel (docked in the terminal's fullscreen layout, inline on its main screen). Top to bottom:

- **What it does**, with **Turn off** (for 1 h, 2 h or until tomorrow; it turns itself back on) and when the next fact can come.
- **Stats**: Today and All time side by side (Shown, Knew, Didn't know, Ignored, Copied, Looked up) and how many you knew. Below them, your **Didn't know** list, newest first, each with its source link, **Looked it up** and **Copy**. Press **Looked it up** once you have read the source: the fact leaves the list, counts as *Looked up*, and never comes back.
- **Settings**, kept across sessions:

| Setting | Default | Range |
| --- | --- | --- |
| Minutes between facts | 20 min | 5 to 120 min, across all sessions |
| Show after | 30 s | 15 to 120 s of a running turn |
| Facts per day | 12 | 1 to 50 |
| AI context | Off | Off, Dependencies, Changed files, Changed files + prompt |
| AI share | 1 of 3 | 1 of 2 to 1 of 5 |
| AI facts per day | 5 | 0 to 20, a hard cap on model calls |

- **Fact base**: every category with a checkbox and how much of it you have seen (`Space · 12 of 40 seen`).

The status line shows `Ipsa Scientia · next fact in 12 min · 3 didn't know`.

### AI facts

Off by default. Each level adds to the one before, so you decide what the model sees:

| AI context | What the model gets |
| --- | --- |
| Off | Nothing. No model calls at all. |
| Dependencies | Language and library names from `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod` |
| Changed files | Plus the names of changed files and their line counts (`git diff --numstat`), never their content |
| Changed files + prompt | Plus the first 300 characters of your current prompt |

The mod sends at most about 1 KB of that to Haiku through `$.model.complete`, with a short fixed instruction. Haiku answers with one fact or with "nothing I'm sure of", and then a built-in fact is shown instead. A call costs a fraction of a cent, it is billed to the account your session uses, and the panel shows today's estimate. The mod never reads your source code or diff content, never reads your conversation (beyond the current prompt at the top level), and never adds anything to the agent's context. `.env*`, `*.pem`, `*.key` and git-ignored files are left out of the file list, so not even their names leave your machine.

AI facts are labelled *AI · about this project*, never claim a source, and come with the note *may be wrong*. Because they may be.

### Your own facts

Add facts of your own in `~/.claude/ipsa-scientia/facts.json`. They are merged in at session start, and new categories show up in the panel marked *yours*. A `source` is optional there. A broken entry is skipped with one toast; the rest still loads.

```json
[
  { "id": "chess-age", "category": "board-games", "text": "Chess has been played for about 1,500 years." }
]
```

To name your categories, use `{ "categories": [{ "id": "board-games", "name": "Board games" }], "facts": [...] }`.

## Health of the facts

Every built-in fact in [`data/facts.json`](data/facts.json) has a `source`, a page where it can be checked, and was checked against it by a human before it shipped. AI facts are not checked by anyone: treat them as a lead, not as a reference.

```jsonc
{
  "id": "mark-ii-moth",                // kebab-case, unique
  "category": "computer-history",
  "text": "In 1947 Harvard Mark II operators taped a moth into their logbook: …",
  "source": "https://en.wikipedia.org/wiki/Software_bug",   // required
  "addedIn": "0.1.0"
}
```

Rules: at most 200 characters, one or two sentences, a source for every fact, no politics, religion, tragedies or health claims that could read as advice, and popular myths only as a correction. With Node 23.6 or newer:

```bash
node scripts/check-facts.mjs
```

checks ids, categories, lengths and sources (`--release` also requires 40 facts per category).

## Develop

```bash
claude plugin validate .
claude plugin test .
tsc -p .
```

`tsc -p .` needs the engine's types in `.claude-plugin/types/`, which Claude Code writes the first time it loads the mod from this folder (`claude --plugin-dir .`).

- `hooks/logic.ts`: every rule as a pure function (when a fact shows, the shuffle bag, counters, the Didn't know list, merging your facts file). No engine calls, so all of it is unit-tested.
- `hooks/ai.ts`: what each AI context level sends, the request, and reading the reply. Also pure and tested.
- `hooks/register.tsx`: wires events to the logic and draws the card and the panel.
- `types/index.d.ts`: shared types and the `$.state` contract.

The UI tests run every case on both the terminal and the desktop surface. With `IPSA_SCIENTIA_DEV=1` in the environment, `/ipsa-scientia` takes developer arguments: `show <fact-id>` (show one fact now), `due` (the gap is over, so the next longer turn shows a fact) and `reset` (remove all of the mod's data).

## Contributing

Everyone is welcome, and anyone who has ever said "well, actually" at a dinner party doubly so.

- **New facts**: open a pull request adding entries to [`data/facts.json`](data/facts.json), each with a source a reader can check. A good fact has a number, a date, a name or a surprise, and makes someone want to look it up.
- **Corrections**: if a fact is wrong, out of date, or one of those myths that sounds true, open an issue with a better source. Being corrected is the whole point of this mod.
- **Code**: bug fixes and ideas are welcome too. Run `claude plugin test .` before opening a pull request.

Knowledge is power. Ten seconds at a time.

## License

[MIT](LICENSE)
