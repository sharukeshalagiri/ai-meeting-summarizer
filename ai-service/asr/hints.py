"""
Vocabulary hints (names, jargon, agenda) turned into Whisper's
initial_prompt.

Whisper has no keyword-boost API; the documented way to bias spelling
is a prompt that reads like preceding transcript. A short glossary
line works best: long prompts start to leak into the output.
"""

from __future__ import annotations

# Whisper's prompt window is 224 tokens and the prompt is truncated from
# the front. ~4 characters per token for English, minus headroom, keeps
# the whole glossary inside the window.
MAX_PROMPT_CHARS = 600
# A single hint longer than this is an agenda paragraph, not a term;
# it is cut so one long hint cannot crowd out every name.
MAX_HINT_CHARS = 80
PROMPT_PREFIX = "Glossary: "


def build_initial_prompt(hints: list[str] | None) -> str | None:
    """
    Joins hints in the given order (the caller puts roster names first),
    de-duplicated case-insensitively, capped at MAX_PROMPT_CHARS. None
    when there is nothing to say, so Whisper runs unprompted.
    """
    seen: set[str] = set()
    terms: list[str] = []
    length = len(PROMPT_PREFIX)

    for raw in hints or []:
        if not isinstance(raw, str):
            continue

        term = " ".join(raw.split())[:MAX_HINT_CHARS].strip(" ,.;")
        key = term.lower()

        if not term or key in seen:
            continue

        extra = len(term) + (2 if terms else 0)
        if length + extra > MAX_PROMPT_CHARS:
            break

        seen.add(key)
        terms.append(term)
        length += extra

    if not terms:
        return None

    return PROMPT_PREFIX + ", ".join(terms) + "."
