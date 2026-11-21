# How the work was organised

This project was built by one engineer directing several AI coding agents
(Claude Code) at once. These files are the rules that kept them from
colliding; they are about the process, not the product.

- [PARALLEL.md](PARALLEL.md): how a track starts, what it may touch, and
  the finish protocol every PR followed.
- [OWNERSHIP.md](OWNERSHIP.md): which paths each track owned, enforced by
  `npm run check:ownership` and the CI `ownership` job.
- [../decisions/](../decisions/): each track's own decision notes, folded
  into [../DECISIONS.md](../DECISIONS.md) when its PR was integrated.
- [../../CLAUDE.md](../../CLAUDE.md): the operating manual the agents
  read first, including the decision gates where they stop and ask.

Track ids (`w1-sum`, `w3-jobs`, ...) name the work streams, not the code:
source files are named by domain (`summaryPipeline.service.ts`,
`processing.routes.ts`).
