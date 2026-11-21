import type { DemoMeetingSpec } from "../types";
import { inferred, item, src } from "./helpers";

/**
 * Lecture demo. The transcript is fixtures/transcripts/lecture.json
 * (synthetic); the recording user is the student on the mic channel.
 * The summary respects that fixture's answer key: both exam flags, the
 * definition and the homework appear; the small talk, the "duct tape"
 * aside and the optional cuckoo reading do not.
 */
export const lecture: DemoMeetingSpec = {
  key: "lecture",
  title: "Data Structures, lecture 9: hash tables",
  description: "Synthetic demo lecture: two exam flags, one homework.",
  mode: "LECTURE",
  daysAgo: 1,
  me: "Student",
  lines: [
    ["Professor", "Alright, let's settle in. Before we start, how was everyone's weekend? Anyone see the game?"],
    ["Student", "We lost, don't remind us."],
    ["Professor", "Ha, sorry to hear it. Okay, today we're covering hash tables, which build directly on last week's arrays."],
    ["Professor", "Let's start with a definition. A hash function is a function that maps a key of arbitrary size to a fixed-size integer, which we use as an index into an array of buckets."],
    ["Professor", "The important property is that the same key always produces the same index, and different keys should spread out evenly."],
    ["Professor", "When two keys land in the same bucket, there are two main ways to handle it."],
    ["Professor", "The first is separate chaining, where each bucket holds a linked list of entries."],
    ["Professor", "The second is open addressing, where you probe for the next free slot, for example with linear probing."],
    ["Professor", "Pay attention to this next part, because this will be on the exam: the difference between chaining and open addressing, and when you'd pick each."],
    ["Student", "Is it okay if we just memorize the definitions?"],
    ["Professor", "Definitions won't be enough, you'll need to explain the trade-off. Chaining degrades gracefully, open addressing has better cache behavior."],
    ["Professor", "Now, the load factor, which you saw in the reading for today."],
    ["Professor", "When the load factor gets too high, around zero point seven five for open addressing, you resize and rehash everything."],
    ["Professor", "And again, this will be on the exam: computing the amortized cost of insertion when the table doubles in size."],
    ["Professor", "As a side note, my old advisor used to say hash tables are the duct tape of computer science. Not on the exam, just a nice line."],
    ["Student", "Will the slides be posted?"],
    ["Professor", "Yes, the slides will be up tonight."],
    ["Professor", "For homework, implement a hash table with separate chaining in the language of your choice, with insert, lookup and delete."],
    ["Professor", "The homework is due next Tuesday before class. Submit it through the course portal."],
    ["Professor", "If you finish early, you might enjoy reading about cuckoo hashing, but that's purely optional."],
    ["Professor", "Okay, that's time. See you Thursday."],
  ],
  noise: {
    0: "small_talk",
    1: "small_talk",
    14: "off_topic",
    15: "logistics",
    16: "logistics",
    19: "off_topic",
    20: "logistics",
  },
  summary: {
    tldr:
      "Hash tables: hash functions, collision handling with separate chaining or open addressing, and resizing by load factor. " +
      "Two topics are flagged for the exam. Homework: a chained hash table, due next Tuesday.",
    keyPoints: [
      item("A hash function maps a key of any size to a fixed-size integer, used as an index into an array of buckets.", 3),
      item("The same key must always give the same index, and different keys should spread out evenly.", 4),
      item("Collisions are handled by separate chaining (a linked list per bucket) or open addressing (probe for the next free slot).", 6, 7),
      item("Chaining degrades gracefully; open addressing has better cache behavior.", 10),
      item("When the load factor gets too high (around 0.75 for open addressing), resize and rehash everything.", 12),
    ],
    decisions: [],
    actionItems: [
      {
        task: "Implement a hash table with separate chaining (insert, lookup, delete) and submit it through the course portal",
        owner: null,
        assignedBy: "Professor",
        dueSpoken: "next Tuesday",
        dueDate: null,
        priority: "HIGH",
        ...src(17, 18),
      },
    ],
    dates: [
      { spoken: "next Tuesday", date: null, description: "Hash table homework due before class", ...src(18) },
      { spoken: "Thursday", date: null, description: "Next lecture", ...src(20) },
    ],
    openQuestions: [],
    whoSaidWhat: [],
    glossary: [
      {
        term: "Hash function",
        definition: "Maps a key of arbitrary size to a fixed-size integer, used as an index into an array of buckets.",
        ...src(3),
      },
      {
        term: "Load factor",
        definition: "How full the table is; past about 0.75 with open addressing, the table is resized and rehashed.",
        ...src(11, 12),
      },
    ],
    nextSessionPrep: [item("Be ready to explain when you would pick chaining over open addressing.", 8, 10)],
    keywords: ["hash tables", "hash function", "separate chaining", "open addressing", "linear probing", "load factor", "amortized cost"],
    sentiment: { overall: "NEUTRAL", rationale: "A routine lecture with a light start." },
    sections: {
      lecture: {
        outline: [
          item("Hash functions and what makes a good one", 3, 4),
          item("Collision handling: separate chaining and open addressing", 5, 6, 7),
          item("Load factor, resizing and rehashing", 11, 12),
          item("Amortized cost of insertion when the table doubles", 13),
        ],
        definitions: [
          {
            term: "Hash function",
            definition: "Maps a key of arbitrary size to a fixed-size integer, used as a bucket index.",
            ...src(3),
          },
          { term: "Separate chaining", definition: "Each bucket holds a linked list of entries.", ...src(6) },
          {
            term: "Open addressing",
            definition: "On a collision, probe for the next free slot, for example with linear probing.",
            ...src(7),
          },
        ],
        formulas: [
          {
            expression: "load factor > 0.75 → resize and rehash",
            meaning: "The threshold given for open addressing.",
            ...src(12),
          },
        ],
        examQuestions: {
          flaggedByLecturer: [
            {
              question: "Explain the difference between chaining and open addressing, and when you would pick each.",
              reason: "\"This will be on the exam\"; definitions alone won't be enough, explain the trade-off.",
              ...src(8, 10),
            },
            {
              question: "Compute the amortized cost of insertion when the table doubles in size.",
              reason: "\"And again, this will be on the exam.\"",
              ...src(13),
            },
          ],
          likely: [
            {
              question: "What load factor triggers a resize, and what happens during a rehash?",
              reason: "Stressed in class and tied to the assigned reading.",
              ...inferred(11, 12),
            },
          ],
        },
        assignments: [
          {
            task: "Implement a hash table with separate chaining (insert, lookup, delete), in any language",
            dueSpoken: "next Tuesday",
            dueDate: null,
            ...src(17, 18),
          },
        ],
        studyChecklist: [
          item("Explain the chaining vs open addressing trade-off in your own words", 10),
          item("Work through the amortized analysis of table doubling", 13),
        ],
      },
    },
  },
};
