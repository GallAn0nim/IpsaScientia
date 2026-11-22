// ipsa-scientia: the shared types and the $.state contract.

// ---- The fact base (data/facts.json, ~/.claude/ipsa-scientia/facts.json) ----

export type Fact = {
  /** kebab-case, unique across the base and the user file */
  id: string
  /** a category id: one of the built-in eight, or any kebab-case id in the user file */
  category: string
  /** at most 200 characters, English */
  text: string
  /** required for built-in facts: a page where the fact can be checked */
  source?: string
  /** the version that added it */
  addedIn?: string
  /** came from the user facts file */
  isUser?: boolean
}

export type CategoryDef = { id: string; name: string }

/** data/facts.json */
export type FactFile = { v: 1; categories: CategoryDef[]; facts: Fact[] }

/** A category as the panel lists it. */
export type CategoryInfo = { id: string; name: string; isUser: boolean; size: number; seen: number }

// ---- Store values (every key prefixed is., every value carries v: 1) ----

/** Off, Dependencies, Changed files, Changed files + prompt. */
export type AiContext = 'off' | 'deps' | 'files' | 'files-prompt'

/** is.settings */
export type Settings = {
  v: 1
  enabled: boolean
  /** 5–120 */
  minutesBetween: number
  /** 15–120 */
  showAfterSeconds: number
  /** 1–50 */
  factsPerDay: number
  disabledCategories: string[]
  aiContext: AiContext
  /** one fact in this many comes from AI: 2–5 */
  aiShare: number
  /** 0–20, a hard cap on model calls */
  aiPerDay: number
  /** the person pressed "Turn on AI facts" once */
  aiConsented: boolean
}

/** is.pause: epoch ms the mod turns itself back on */
export type Pause = { v: 1; until: number }

export type Counts = {
  shown: number
  knew: number
  didntKnow: number
  ignored: number
  copied: number
  lookedUp: number
}

/** is.day */
export type Day = {
  v: 1
  /** local date, YYYY-MM-DD */
  date: string
  counts: Counts
  /** epoch ms of the last fact shown in any session; kept across days */
  lastFactAt: number | null
  /** which session and turn claimed the last fact, so two sessions never both show one */
  lastFactBy?: string
  /** model calls made today */
  aiCalls: number
  /** estimated dollars of today's model calls */
  aiCostUsd: number
  /** facts shown since the last AI fact, for the AI share */
  sinceAi: number
}

/** is.totals */
export type Totals = { v: 1; counts: Counts }

/** What became of a knowledge-base fact. `lookedUp`: it was on the Didn't know list and was looked up. */
export type Outcome = 'knew' | 'ignored' | 'didntKnow' | 'lookedUp'

/** is.seen */
export type Seen = { v: 1; byId: Record<string, Outcome> }

/** is.bag: the picking queue */
export type Bag = { v: 1; ids: string[] }

export type DidntKnowItem = {
  /** the fact's id, or `ai-<time>` for an AI fact */
  id: string
  text: string
  category: string
  source?: string
  /** local date, YYYY-MM-DD */
  date: string
  isAi: boolean
}

/** is.didntKnow, newest first */
export type DidntKnow = { v: 1; items: DidntKnowItem[] }

/** The fact on the card: this session's only. */
export type Card = {
  /** unique per showing */
  key: string
  factId?: string
  text: string
  category: string
  source?: string
  isAi: boolean
  shownAt: number
  /** set when the turn ends: the card hides itself then */
  hideAt: number | null
  isCopied: boolean
}

/** An AI fact asked for in advance, kept until a card uses it. */
export type AiFact = { text: string; category: string }

// Aliases for the contract below: inside `declare module 'claude-code'` the
// engine's own names (it has a `Settings` too) shadow this file's.
export type IsSettings = Settings
export type IsDay = Day
export type IsTotals = Totals
export type IsPause = Pause
export type IsDidntKnow = DidntKnow
export type IsCard = Card
export type IsCategoryInfo = CategoryInfo
export type IsAiContext = AiContext

declare module 'claude-code' {
  interface PluginState {
    // Session mirrors of the store, so the card and the panel redraw when they change.
    'ipsa-scientia': {
      settings: IsSettings
      day: IsDay | null
      totals: IsTotals | null
      pause: IsPause | null
      didntKnow: IsDidntKnow | null
      categories: IsCategoryInfo[]
      /** the fact on this session's card */
      card: IsCard | null
      /** when this session's running turn started, or null between turns */
      turnStartedAt: number | null
      /** the panel is asking how long to turn off for */
      isAskingPause: boolean
      /** a level picked in the panel that waits for "Turn on AI facts" */
      pendingAiContext: IsAiContext | null
      /** the clock at the last poll, so "Next fact in" redraws as time passes */
      now: number
    }
  }
}
