# Track decision logs

Each parallel track writes `docs/decisions/<track>.md` (for example
`w1-sum.md`) instead of editing `docs/DECISIONS.md`. The integrator folds
the important entries into `docs/DECISIONS.md` when it merges the wave.

Use the same shape as `docs/DECISIONS.md`. For each decision:

- **Constraint**: what forced a choice.
- **Considered**: the options, and why the others lost.
- **Chosen**: what you did and what it costs.
- **For the integrator**: follow-ups, requests for other tracks and known
  gaps.
