# Documentation

Start here.

| Document | What it is | Read it when |
|---|---|---|
| [PLAN.md](PLAN.md) | The implementation plan: data findings, architecture, folder structure, schema, risks, todos | Before writing code, and whenever a task starts |
| [REQUIREMENTS.md](REQUIREMENTS.md) | Every requirement in the brief traced to where it is satisfied, plus deliberate limitations | Before submitting. Re-run the audit |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Full system walkthrough: topology, complete data flow, per-stage detail, state machines | When asked how something works |
| [DECISIONS.md](DECISIONS.md) | Every choice, what was rejected, and why. Includes alignment with the target role | When asked why something is the way it is. This is the answer key for the interview |
| [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) | Ambiguities we closed by assumption, plus the ramifications register with blast radius and mitigation | Before the interview. Be ready to say what we assumed and how we would flip it |
| [GLOSSARY.md](GLOSSARY.md) | Sourcing vocabulary, with terms invented for this project marked | Any time a term is unfamiliar |
| [PRESENTATION.md](PRESENTATION.md) | Timed video script and the interview deck outline | Before recording, and before the interview |

Run instructions live in the root [`README.md`](../README.md), not here.

## Working agreement

- `PLAN.md` is a copy of the working plan and is refreshed when the plan changes.
- `DECISIONS.md` gains file and function references as code lands. A decision made while coding that is not written here is a decision that will be forgotten before the interview.
- `REQUIREMENTS.md` gets re-audited before submission, not once at the start.
- `OPEN-QUESTIONS.md` is where a brief ambiguity is closed by assumption (with a seam and, for a few forks, the other path), and where a risk goes the moment it is noticed. An unmitigated risk that was seen and named is a much better answer than one that was missed.
