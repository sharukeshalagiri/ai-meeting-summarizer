import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import EmptyState from "../components/EmptyState";
import { getErrorMessage, postData } from "../api/api";
import type { ChatAnswer, Citation } from "../types/meeting";

interface Turn {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
}

const SUGGESTIONS = [
  "What decisions were made?",
  "What deadlines were mentioned?",
  "What is currently blocking us?",
  "What questions were left unanswered?",
];

/**
 * Chat grounded in meeting transcripts.
 *
 * Every assistant answer carries the transcript moments it was drawn
 * from, so a claim can be checked rather than trusted.
 */
function Ask() {
  const [params] = useSearchParams();

  // Scoping to one meeting narrows retrieval to that transcript.
  const meetingId = params.get("meetingId");

  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(
    null
  );

  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({
      top: threadRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [turns, pending]);

  const send = async (text: string) => {
    const trimmed = text.trim();

    if (!trimmed || pending) return;

    setError(null);
    setQuestion("");
    setTurns((current) => [
      ...current,
      { role: "user", content: trimmed },
    ]);
    setPending(true);

    try {
      const result = await postData<ChatAnswer>(
        "/chat",
        {
          question: trimmed,
          conversationId,
          meetingId,
        },
        { timeout: 3 * 60 * 1000 }
      );

      setConversationId(result.conversationId);

      setTurns((current) => [
        ...current,
        {
          role: "assistant",
          content: result.answer,
          citations: result.citations,
        },
      ]);
    } catch (err) {
      console.error(err);

      setError(getErrorMessage(err));

      // Drop the unanswered question so a retry does not stack two
      // copies of it in the thread.
      setTurns((current) => current.slice(0, -1));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>Ask your meetings</h1>
          <p className="muted">
            {meetingId
              ? "Answers are drawn from this meeting's transcript."
              : "Answers are drawn from every transcript, with citations."}
          </p>
        </div>
      </header>

      <div className="chat-thread" ref={threadRef}>
        {turns.length === 0 && !pending && (
          <EmptyState
            title="Ask anything about your meetings"
            body="Every answer cites the moment in the transcript it came from."
          />
        )}

        {turns.map((turn, index) => (
          <div
            key={index}
            className={`chat-turn chat-${turn.role}`}
          >
            <div className="chat-bubble">
              <p>{turn.content}</p>

              {turn.citations && turn.citations.length > 0 && (
                <div className="citations">
                  <span className="citations-title">Sources</span>

                  {turn.citations.map((citation) => (
                    <Link
                      key={citation.segmentId}
                      to={`/meeting/${citation.meetingId}?t=${citation.startMs}`}
                      className="citation"
                    >
                      <span className="citation-head">
                        {citation.meetingTitle}
                        <span className="citation-time">
                          {citation.speaker} · {citation.timestamp}
                        </span>
                      </span>
                      <span className="citation-text">
                        &ldquo;{citation.text}&rdquo;
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {pending && (
          <div className="chat-turn chat-assistant">
            <div className="chat-bubble">
              <span className="typing" aria-label="Thinking">
                <span />
                <span />
                <span />
              </span>
            </div>
          </div>
        )}
      </div>

      {error && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}

      {turns.length === 0 && (
        <div className="suggestions">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="chip-button"
              onClick={() => void send(suggestion)}
              disabled={pending}
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send(question);
        }}
      >
        <label htmlFor="question" className="sr-only">
          Your question
        </label>

        <input
          id="question"
          type="text"
          placeholder="What did we decide about the launch date?"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          disabled={pending}
          autoComplete="off"
        />

        <button type="submit" disabled={pending || !question.trim()}>
          {pending ? <span className="spinner" /> : "Ask"}
        </button>
      </form>
    </div>
  );
}

export default Ask;
