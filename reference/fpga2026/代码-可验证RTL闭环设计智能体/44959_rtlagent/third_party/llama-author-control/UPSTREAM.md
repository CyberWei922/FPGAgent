# Pinned public sampler ABI

Upstream: https://github.com/ggml-org/llama.cpp/tree/f114f91

Reviewed public sources:

- `include/llama.h`: sampler interface, token conversion, DRY factory.
- `common/sampling.cpp`: chain ordering and generated-token acceptance.
- `common/reasoning-budget.cpp`: forced-token convergence mechanism.
- `src/llama-sampler.cpp`: upstream DRY implementation.
- `LICENSE`: MIT, read on 2026-10-23; retain notice for ABI declarations.

`llama-sampler-abi.h` contains the small required subset of public declarations,
not a decompilation. Adapter and state machine are project-authored. Upstream DRY
algorithm is invoked from the installed library, not copied or reimplemented.
The pinned ABI must not be assumed compatible with another build. No model
weights, binaries, credentials, benchmark answers or raw model output belong here.

Linux build (output must be outside the source tree):

    g++ -std=c++17 -O2 -fPIC -shared author-control.cpp -ldl -o /absolute/output/libauthor-control.so

Launch only the dedicated, non-speculative, single-slot author service with
`LD_PRELOAD=/absolute/output/libauthor-control.so` and a fresh private
`RTL_AUTHOR_CONTROL_DIR=/absolute/state/directory`. The existing server and
libraries stay intact. Do not enable GPU/backend sampling or speculative decode.
The harness checks the startup capability receipt and per-request native receipt.
Unmarked official baseline and old Agent requests use the original factory.

The marker in `dry_sequence_breakers` is a private adapter protocol, NOT an
upstream llama.cpp option. Never send marked requests without a verified adapter.

Project adapter behavior version: `rtl-author-control-v3` (public ABI unchanged).
At the existing late budget, v3 may abandon an unsubmitted, unfenced raw draft
at a complete lexical line and prompt ONE complete formal submission. This is
not an RTL repair or draft acceptance. Fenced code, comments, strings, formal
answers and overflow remain protected; DRY is still analysis-only. Receipts
record `draft_abandoned` separately. v2 receipts cannot satisfy v3 preflight.
