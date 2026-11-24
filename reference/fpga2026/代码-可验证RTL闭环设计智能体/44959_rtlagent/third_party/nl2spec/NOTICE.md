# nl2spec method attribution

Upstream: https://github.com/realChrisHahn2/nl2spec

Inspected revision: `1765c9cd1069ee560ae67ea71e67c8fa134b3d14` (main resolved 2026-10-22).

Paper: Matthias Cosler, Christopher Hahn, Daniel Mendoza, Frederik Schmitt,
Caroline Trippel, *nl2spec: Interactively Translating Unstructured Natural
Language to Temporal Logics with Large Language Models*, CAV 2023.
https://arxiv.org/abs/2303.04864

License: MIT. The accompanying LICENSE preserves the upstream notice, including
the upstream spelling of the copyright holder. Retain this notice and license
when redistributing this adaptation. Dependency licenses are not implied by MIT.

Inspected upstream components: README, `prompts/minimal.txt`, `src/backend.py`,
`src/prompting.py`, `src/ambiguity.py`, and LICENSE. The method uses few-shot
temporal translation, source-fragment/subformula mappings and interactive
correction. Its agreement-frequency scores are not probabilities of correctness.

RTL2LLM's `rtl-agent/src/planner/temporal-contract.mjs` is a new JavaScript
method adaptation, not a vendored/executed copy of the upstream framework.
It uses the existing local 27B planner, a compact source-linked temporal
contract and at most one structural/provenance correction within the existing
planning budget. It replaces general LTL formulas with explicit sampled-event
relations and prose suitable for the existing Markdown handoff to the 8B author.
Teaching examples are synthetic and task-independent. It does not import the
upstream prompt verbatim or use the upstream model clients, web server, example
datasets, human-interface loop, majority voting, formula parser or DFA backend.

Consequently this adaptation is NOT an LTL implementation, SVA generator,
formal verifier, automated semantic disambiguator, or a reproduction of the
paper's results. Structure/provenance checks cannot prove that an interpretation
matches a natural-language requirement. No upstream cloud provider is called,
no new inference weights are installed and no third-party EDA engine is added.

The MIT grant is separate from competition permission. This integration remains
advisory auxiliary planning: only the 8B authors or repairs final RTL. It never
reads golden testbenches/reference answers, emits executable auxiliary RTL, or
replaces the existing grading toolchain. See `docs/new-agent/nl2spec-temporal.md`
in the source repository for scope, configuration and acceptance status.
