"""Unit tests for the pure helpers: guards, hints, chunk boundaries, channels."""

import pytest

from conftest import seg


@pytest.fixture()
def asr(fake_whisper):
    from asr import channels, chunking, engine, guards, hints

    return type("ASR", (), {"guards": guards, "hints": hints, "chunking": chunking,
                            "engine": engine, "channels": channels})


def to_engine(asr, s):
    E = asr.engine
    return E.EngineSegment(
        text=s.text.strip(), start=s.start, end=s.end, no_speech_prob=s.no_speech_prob,
        avg_logprob=s.avg_logprob, compression_ratio=s.compression_ratio,
        words=[E.EngineWord(w.word, w.start, w.end, w.probability) for w in s.words],
    )


# --- guards ------------------------------------------------------------

def test_no_speech_needs_both_signals(asr):
    g = asr.guards
    both = to_engine(asr, seg("Thanks.", 0, 1, no_speech=0.9, logprob=-1.5))
    only_no_speech = to_engine(asr, seg("quiet but real", 0, 1, no_speech=0.9, logprob=-0.3))
    only_low_logprob = to_engine(asr, seg("hard accent", 0, 1, no_speech=0.1, logprob=-1.5))

    assert [s.text for s in g.apply_guards([both, only_no_speech, only_low_logprob])] == [
        "quiet but real",
        "hard accent",
    ]


def test_high_compression_ratio_is_dropped(asr):
    loop = to_engine(asr, seg("go go go go go go go go go go", 0, 5, ratio=3.1))
    assert asr.guards.apply_guards([loop]) == []


def test_phrase_repeated_three_times_is_collapsed(asr):
    s = to_engine(asr, seg("we should ship it ship it ship it today", 0, 4))
    [out] = asr.guards.apply_guards([s])
    assert out.text == "we should ship it today"
    assert [w.word.strip() for w in out.words] == ["we", "should", "ship", "it", "today"]


def test_phrase_repeated_twice_is_kept(asr):
    s = to_engine(asr, seg("no no that is wrong", 0, 2))
    assert asr.guards.apply_guards([s])[0].text == "no no that is wrong"


def test_collapse_without_words_uses_text(asr):
    s = to_engine(asr, seg("ok", 0, 1))
    s.text, s.words = "yes. yes. yes. yes. right", []
    assert asr.guards.apply_guards([s])[0].text == "yes. right"


@pytest.mark.parametrize("text", ["[Music]", "(silence)", "♪ ♪", "*applause*", "[BLANK_AUDIO] (music)", "..."])
def test_non_speech_annotations_are_dropped(asr, text):
    s = to_engine(asr, seg("x", 0, 1))
    s.text, s.words = text, []
    assert asr.guards.apply_guards([s]) == []


def test_stock_hallucination_dropped_only_when_doubtful(asr):
    doubtful = to_engine(asr, seg("Thank you for watching!", 0, 1, no_speech=0.4))
    confident = to_engine(asr, seg("Thank you for watching!", 0, 1, no_speech=0.01))
    assert asr.guards.apply_guards([doubtful]) == []
    assert len(asr.guards.apply_guards([confident])) == 1


# --- hints -------------------------------------------------------------

def test_prompt_dedupes_and_caps(asr):
    h = asr.hints
    assert h.build_initial_prompt(None) is None
    assert h.build_initial_prompt(["", "  "]) is None
    assert h.build_initial_prompt(["Priya", "priya", " Kubernetes ", 5]) == "Glossary: Priya, Kubernetes."

    many = [f"term{i:03d}" for i in range(500)]
    prompt = h.build_initial_prompt(many)
    assert len(prompt) <= h.MAX_PROMPT_CHARS + 1
    assert prompt.startswith("Glossary: term000, term001")

    long_hint = "x" * 1000
    assert len(h.build_initial_prompt([long_hint])) <= len(h.PROMPT_PREFIX) + h.MAX_HINT_CHARS + 1


# --- chunk boundaries -------------------------------------------------------

def W(w, start, end, p=0.9, channel=None):
    out = {"w": w, "startMs": start, "endMs": end, "p": p}
    if channel:
        out["channel"] = channel
    return out


def S(words, channel=None):
    return {"text": " ".join(w["w"] for w in words), "startMs": words[0]["startMs"],
            "endMs": words[-1]["endMs"], "channel": channel, "words": words}


def test_edge_fragments_with_low_confidence_are_trimmed(asr):
    c = asr.chunking
    segment = S([W("ro", 10000, 10100, p=0.2), W("adding", 10100, 10500), W("tomorrow", 10600, 11000),
                 W("we", 19500, 19800), W("sh", 19850, 20000, p=0.1)])
    [out] = c.trim_edge_fragments([segment], 10000, 20000)
    assert out["text"] == "adding tomorrow we"
    assert out["startMs"] == 10100


def test_confident_edge_words_are_kept(asr):
    segment = S([W("Hello", 0, 200, p=0.95)])
    assert asr.chunking.trim_edge_fragments([segment], 0, 5000) == [segment]


def test_boundary_dedup_removes_longest_repeated_run(asr):
    prev = [W("the", 9000, 9300), W("next", 9300, 9600), W("sprint", 9600, 10000)]
    segs = [S([W("next", 10000, 10200), W("sprint", 10200, 10500), W("starts", 10600, 11000)])]
    [out] = asr.chunking.dedupe_against_previous(segs, prev)
    assert out["text"] == "starts"
    assert out["startMs"] == 10600


def test_boundary_dedup_can_consume_a_whole_segment(asr):
    prev = [W("okay", 9500, 9900)]
    segs = [S([W("Okay.", 10000, 10300)]), S([W("Moving", 11000, 11300), W("on", 11300, 11500)])]
    out = asr.chunking.dedupe_against_previous(segs, prev)
    assert [s["text"] for s in out] == ["Moving on"]


def test_boundary_dedup_ignores_repeats_far_from_the_cut(asr):
    prev = [W("yes", 5000, 5300)]
    segs = [S([W("yes", 10000, 10300), W("agreed", 10300, 10700)])]
    assert asr.chunking.dedupe_against_previous(segs, prev) == segs


def test_boundary_dedup_no_match_or_no_context(asr):
    segs = [S([W("hello", 0, 300)])]
    assert asr.chunking.dedupe_against_previous(segs, None) == segs
    assert asr.chunking.dedupe_against_previous(segs, [W("bye", 0, 100)]) == segs


# --- channels -------------------------------------------------------------

def test_silence_detection(asr):
    import numpy as np

    assert asr.channels.is_silent(np.zeros(1600, dtype=np.float32))
    assert asr.channels.is_silent([])
    assert not asr.channels.is_silent(np.full(1600, 0.05, dtype=np.float32))


def test_echo_needs_overlap_and_similar_text(asr):
    ch = asr.channels
    remote = [{"text": "Ship it Friday", "startMs": 0, "endMs": 2000}]
    echo = {"text": "ship it friday", "startMs": 100, "endMs": 2000}
    later = {"text": "ship it friday", "startMs": 5000, "endMs": 7000}
    reply = {"text": "No, Monday", "startMs": 500, "endMs": 1500}
    assert ch.drop_echo([echo, later, reply], remote) == [later, reply]
