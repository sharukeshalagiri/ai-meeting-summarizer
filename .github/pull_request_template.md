## Track and wave

- **Track:** <!-- e.g. w1-sum, or "integrator" / "chore" -->
- **Wave:** <!-- 1-5; also set the wave-<n> label -->

## Summary

<!-- What changed and why, in a few bullets. -->

## Files outside ownership

<!-- Must be "None". `npm run check:ownership` and the CI ownership job
     enforce docs/OWNERSHIP.md. Shared registration files (append-only)
     do not count. -->

None

## Requests for other tracks

<!-- Changes you needed in files you do not own: file, what, why.
     Write "None" if there are none. -->

None

## Test evidence

<!-- Commands run and their results (typecheck, tests, check:ownership).
     Paste the pass/fail summary lines. -->

- [ ] Typecheck + tests pass for every package touched
- [ ] `npm run check:ownership` passes
- [ ] `docs/decisions/<track>.md` written or updated
- [ ] Rebased on `origin/main` and tests re-run

## Manual test steps

<!-- Steps a human can follow to see it work (2 minutes or less). Use
     "N/A" if none. -->
