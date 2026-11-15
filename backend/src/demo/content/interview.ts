import type { DemoMeetingSpec } from "../types";
import { inferred, item, src } from "./helpers";

/**
 * Interview demo. The transcript is
 * fixtures/transcripts/interview-interviewer.json (synthetic); the
 * recording user is Dana, the interviewer. The summary respects that
 * fixture's answer key (three Q&As, the indexing concern, the token
 * bucket strength, Dana's feedback task; no traffic, dog or "more
 * memory" advice).
 */
export const interview: DemoMeetingSpec = {
  key: "interview",
  title: "Backend engineer interview: Ravi",
  description: "Synthetic demo interview, recorded by the interviewer.",
  mode: "INTERVIEW",
  daysAgo: 3,
  me: "Dana",
  lines: [
    ["Dana", "Hi Ravi, thanks for coming in. Did you find the office alright?"],
    ["Ravi", "Yes, though the traffic on the bridge was terrible this morning."],
    ["Dana", "It always is on Mondays. Is that your dog barking in the background earlier on the call?"],
    ["Ravi", "Ha, yes, that's Biscuit, sorry about that."],
    ["Dana", "No problem. Let's get started. First question: how would you design a rate limiter for a public API?"],
    ["Ravi", "I'd use a token bucket per API key, stored in Redis, so every instance of the service shares the same counters."],
    ["Ravi", "Each request takes a token, tokens refill at a fixed rate, and when the bucket is empty we return a 429 with a Retry-After header."],
    ["Dana", "Good. What happens if Redis goes down?"],
    ["Ravi", "I'd fail open with a local in-memory limit as a fallback, so an outage of the limiter doesn't take the whole API down."],
    ["Dana", "Okay. Second question: a query on the orders table got slow as the table grew. How would you speed it up?"],
    ["Ravi", "Hmm, I'm honestly not sure. Maybe add more memory to the database server? I haven't worked much with database indexes."],
    ["Dana", "Would an index on the customer id column help here, do you think?"],
    ["Ravi", "I think so, but I couldn't really explain how an index changes the query plan."],
    ["Dana", "That's fine. Last one: tell me about a time you disagreed with a teammate."],
    ["Ravi", "On my last team we disagreed about rewriting a service. I wrote a one-page comparison of both options and we agreed to refactor instead of rewriting."],
    ["Dana", "Nice, that's a clear example of resolving conflict with data."],
    ["Ravi", "Thanks. Can I ask when I'll hear back?"],
    ["Dana", "I'll send my feedback to the hiring committee by Thursday, and the recruiter will contact you after that."],
    ["Ravi", "Great, thank you for your time."],
    ["Dana", "Thanks Ravi, enjoy the rest of your day."],
  ],
  noise: {
    0: "small_talk",
    1: "small_talk",
    2: "small_talk",
    3: "small_talk",
    16: "logistics",
    18: "filler",
    19: "filler",
  },
  summary: {
    tldr:
      "Ravi was strong on rate limiting and gave a clear conflict example, but was unsure about database indexes. " +
      "Dana sends feedback to the hiring committee by Thursday.",
    keyPoints: [
      item("Rate limiter: a token bucket per API key in Redis, shared by every instance, answering 429 with Retry-After.", 5, 6),
      item("If Redis is down, fail open to a local in-memory limit so the API stays up.", 8),
      item("Could not explain how an index on customer id would change the query plan.", 10, 12),
      item("Resolved a rewrite-vs-refactor disagreement with a one-page comparison; the team refactored.", 14),
    ],
    decisions: [],
    actionItems: [
      {
        task: "Send feedback on Ravi to the hiring committee",
        owner: "Dana",
        assignedBy: null,
        dueSpoken: "by Thursday",
        dueDate: null,
        priority: "HIGH",
        ...src(17),
      },
    ],
    dates: [
      {
        spoken: "Thursday",
        date: null,
        description: "Feedback due to the hiring committee; the recruiter contacts Ravi after that",
        ...src(17),
      },
    ],
    openQuestions: [],
    whoSaidWhat: [],
    glossary: [],
    nextSessionPrep: [],
    keywords: ["rate limiter", "token bucket", "Redis", "429", "database index", "query plan"],
    sentiment: { overall: "POSITIVE", rationale: "Friendly and constructive, with one weak answer." },
    sections: {
      interview: {
        qa: [
          {
            question: "How would you design a rate limiter for a public API?",
            answerSummary:
              "Token bucket per API key in Redis, so every instance shares the counters; 429 with Retry-After when empty; fail open to an in-memory limit if Redis is down.",
            ...src(4, 5, 6, 8),
          },
          {
            question: "A query on the orders table got slow as the table grew. How would you speed it up?",
            answerSummary:
              "Unsure; agreed an index on customer id might help but could not explain how it changes the query plan.",
            ...src(9, 10, 12),
          },
          {
            question: "Tell me about a time you disagreed with a teammate.",
            answerSummary: "Wrote a one-page comparison of rewriting vs refactoring a service; the team agreed to refactor.",
            ...src(13, 14),
          },
        ],
        followUps: [{ text: "Probe database fundamentals (indexes, query plans) in a later round", ...inferred(10, 12) }],
        strengths: [
          item("Clear rate limiter design: token bucket per key in Redis, 429 with Retry-After", 5, 6),
          item("Thinks about failure modes: falls back to a local limit if Redis goes down", 8),
          item("Resolves disagreements with data (one-page comparison)", 14, 15),
        ],
        concerns: [item("Little experience with database indexes; could not explain how an index changes the query plan", 10, 12)],
        nextSteps: [item("Dana sends feedback to the hiring committee by Thursday; the recruiter then contacts Ravi", 17)],
        struggledWith: [],
      },
    },
  },
};
