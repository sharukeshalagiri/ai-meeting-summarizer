import type { DemoMeetingSpec } from "../types";
import { item, src } from "./helpers";

/**
 * Project demo. The transcript is fixtures/transcripts/project-meeting.json
 * (synthetic); the recording user is Priya, who runs the meeting. The
 * summary respects that fixture's answer key (one decision, five tasks
 * with owners and deadlines, one open question; none of the rain,
 * puzzle, coffee, lunch, Rust or dark-mode asides).
 */
export const project: DemoMeetingSpec = {
  key: "project",
  title: "Search feature planning",
  description: "Synthetic demo project meeting: one decision, five tasks.",
  mode: "PROJECT",
  daysAgo: 5,
  me: "Priya",
  lines: [
    ["Priya", "Morning everyone, give it a sec, Tom is still joining."],
    ["Marcus", "Did anyone else get caught in that rain on Saturday? I was halfway up the trail when it started."],
    ["Lena", "Ha, I stayed in and finally finished that puzzle. Two thousand pieces."],
    ["Tom", "Sorry, sorry, the coffee machine on four is broken again so I had to go downstairs."],
    ["Priya", "No worries. Okay, let's get into it. The goal today is to lock the plan for the search feature before the beta."],
    ["Priya", "First question is the backend. Marcus, where did you land on Elasticsearch versus Postgres full-text search?"],
    ["Marcus", "I benchmarked both on last month's data. Postgres full-text is within twenty milliseconds of Elasticsearch for our volume, and it's one less service to run."],
    ["Tom", "Half joking, but should we just rewrite the indexer in Rust while we're at it?"],
    ["Marcus", "Let's not. That's a whole quarter of work for no measurable gain."],
    ["Priya", "Agreed, no rewrite. So, are we all comfortable going with Postgres full-text search for version one?"],
    ["Lena", "Yes from me."],
    ["Tom", "Fine by me, it's easier to test."],
    ["Priya", "Great, then that's decided: we use Postgres full-text search for v1 and revisit Elasticsearch only if we outgrow it."],
    ["Priya", "Marcus, can you build the search API endpoint? I'd like it by Friday so Lena isn't blocked."],
    ["Marcus", "Yeah, I'll have the search endpoint up by Friday."],
    ["Priya", "Lena, the search results page."],
    ["Lena", "I can do the results page. I'll aim to have it ready by the end of next week, since it depends on Marcus's endpoint."],
    ["Priya", "Tom, we need a test plan for search, edge cases, empty queries, that kind of thing."],
    ["Tom", "Sure, I'll write the search test plan. I'll get you a draft tomorrow."],
    ["Lena", "Someone could maybe look at dark mode at some point, but that's not for now."],
    ["Priya", "Right, parking that. Marcus, one more thing: the migration for the new search index columns."],
    ["Marcus", "Sure, I'll write that migration too."],
    ["Priya", "And I'll update the beta announcement email to mention search."],
    ["Tom", "Do we know yet whether the beta users get search on day one, or behind a flag?"],
    ["Priya", "Good question, I don't know yet. I'll need to check with sales."],
    ["Lena", "By the way, are we still doing the team lunch thing on Thursday?"],
    ["Marcus", "I hope so, I've been looking forward to that taco place."],
    ["Priya", "Yes, Thursday lunch is on. Okay, I think that's everything. Thanks all."],
  ],
  noise: {
    0: "logistics",
    1: "small_talk",
    2: "small_talk",
    3: "small_talk",
    7: "off_topic",
    8: "off_topic",
    19: "off_topic",
    25: "small_talk",
    26: "small_talk",
    27: "logistics",
  },
  summary: {
    tldr:
      "Search v1 will use Postgres full-text search. Marcus builds the endpoint by Friday and the migration, Lena the results page, " +
      "Tom the test plan. Still open: whether beta users get search on day one or behind a flag.",
    keyPoints: [
      item("Postgres full-text search is within 20 ms of Elasticsearch on last month's data, and is one less service to run.", 6),
      item("Lena's results page depends on Marcus's endpoint.", 13, 16),
    ],
    decisions: [
      {
        text: "Use Postgres full-text search for v1; revisit Elasticsearch only if we outgrow it",
        decidedBy: "Priya",
        ...src(12),
      },
    ],
    actionItems: [
      {
        task: "Build the search API endpoint",
        owner: "Marcus",
        assignedBy: "Priya",
        dueSpoken: "by Friday",
        dueDate: null,
        priority: "HIGH",
        ...src(13, 14),
      },
      {
        task: "Build the search results page",
        owner: "Lena",
        assignedBy: "Priya",
        dueSpoken: "by the end of next week",
        dueDate: null,
        priority: "MEDIUM",
        ...src(16),
      },
      {
        task: "Write the search test plan (edge cases, empty queries)",
        owner: "Tom",
        assignedBy: "Priya",
        dueSpoken: "tomorrow",
        dueDate: null,
        priority: "MEDIUM",
        ...src(17, 18),
      },
      {
        task: "Write the migration for the new search index columns",
        owner: "Marcus",
        assignedBy: "Priya",
        dueSpoken: null,
        dueDate: null,
        priority: "MEDIUM",
        ...src(20, 21),
      },
      {
        task: "Update the beta announcement email to mention search",
        owner: "Priya",
        assignedBy: null,
        dueSpoken: null,
        dueDate: null,
        priority: "LOW",
        ...src(22),
      },
    ],
    dates: [
      { spoken: "Friday", date: null, description: "Search endpoint due (Marcus)", ...src(14) },
      { spoken: "end of next week", date: null, description: "Results page target (Lena)", ...src(16) },
      { spoken: "tomorrow", date: null, description: "Draft search test plan (Tom)", ...src(18) },
    ],
    openQuestions: [item("Do beta users get search on day one, or behind a flag? Priya will check with sales.", 23, 24)],
    whoSaidWhat: [
      { speaker: "Marcus", text: "Benchmarked both: Postgres full-text is within 20 ms of Elasticsearch for our volume.", ...src(6) },
      { speaker: "Priya", text: "Decided Postgres full-text search for v1, Elasticsearch only if we outgrow it.", ...src(12) },
    ],
    glossary: [],
    nextSessionPrep: [item("Bring the answer from sales: search on day one, or behind a flag?", 24)],
    keywords: ["search", "Postgres full-text search", "Elasticsearch", "beta", "endpoint", "results page", "test plan"],
    sentiment: { overall: "POSITIVE", rationale: "Quick agreement and clear ownership." },
    sections: {
      project: {
        people: [
          {
            name: "Marcus",
            done: [item("Benchmarked Elasticsearch against Postgres full-text search on last month's data", 6)],
            next: [item("Search API endpoint by Friday", 14), item("Migration for the search index columns", 21)],
            blockers: [],
          },
          {
            name: "Lena",
            done: [],
            next: [item("Search results page by the end of next week", 16)],
            blockers: [item("Waiting on Marcus's endpoint", 16)],
          },
          { name: "Tom", done: [], next: [item("Search test plan, draft tomorrow", 18)], blockers: [] },
          {
            name: "Priya",
            done: [],
            next: [item("Update the beta announcement email", 22), item("Check with sales about day-one search", 24)],
            blockers: [],
          },
        ],
        risks: [item("The results page slips if the endpoint is late", 13, 16)],
      },
    },
  },
  // The test plan draft was due "tomorrow": shown as done, so the demo
  // has a completed task next to the open ones.
  taskStatus: { 2: "COMPLETED" },
};
