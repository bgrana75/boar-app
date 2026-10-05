# Android chat before/after, Pixel 6a (4–5 Oct 2026)

Raw results behind PR #72 (`perf/android-chat-conversations`). Every number here comes from the phone: the app's
`execution_telemetry` table for conversations, and `npm run eval:device` JSONL for the question sets.

## Setup

- **Phone:** Google Pixel 6a, Tensor G1, 6 GB RAM (5.46 GiB usable), Android 16, dev build (`expo-dev-client`, arm64) served by
  Metro over `adb reverse`, Wi-Fi adb.
- **Models:** Qwen3-4B-Instruct-2507 Q4_K_M (catalog default) and Qwen2.5-1.5B-Instruct Q4_K_M (default on 6–8 GB phones).
- **Library:** bundled corpus + Standard set. No knowledge packs.
- **Conditions:** on battery; every run started from a fresh app launch (force-stop, relaunch, model loaded) and waited until
  the battery was at or below 33.0 °C with thermal status 0, for at most 30 minutes (some runs started at 33.1 °C after the cap).
- **Baseline:** `main` at a6633f8d (the branch's base before the rebase), served from a clean worktree to the same app.

## Conversation protocol (`conversation/`)

The harness runs single questions, so it can't see history growth, follow-ups or answers cut by the step timeout. These runs
drive the real chat screen over adb (`driver.py`: `uiautomator dump` to find the controls, `input text`, Send tapped once):
one new chat, six questions in order, a 30 s pause after each answer, personality **Thorough & Detailed**:

1. How do vaccines work?  2. What are the side effects?  3. Who proposed the theory of evolution by natural selection?
4. What did he publish?  5. Compare the French Revolution and the Industrial Revolution.  6. What is the capital of Australia?

Each `*.json` holds the telemetry rows (`ttft_ms`, `tok_per_sec`, `tokens_generated`, `total_latency_ms`, …) and the
chat messages of the run. "Finished" means the answer ends with sentence punctuation instead of mid-sentence.

| Run | Model | What changed | Code | First word, median | Slowest decode | Longest answer | Tokens | Finished |
|---|---|---|---|---|---|---|---|---|
| `base-4b` | Qwen3-4B | baseline | main a6633f8d | 45.4 s | 0.1 tok/s | 129 s | 1134 | 0 of 6 |
| `fix-4b` | Qwen3-4B | history budget, warm-up fix, follow-up search, length target | branch at 98fd3ed2 (first 5 changes) | 15.3 s | 2.5 tok/s | 122 s | 1644 | 4 of 6 |
| `fix2-4b` | Qwen3-4B | + length from the current speed, history race fixed | 98fd3ed2 + e334679c + 2c92437e (working copy) | 13.4 s | 0.1 tok/s | 127 s | 1187 | 5 of 6 |
| `norepack-4b` | Qwen3-4B | + weights kept as the mapped file, by hand | fix2 + 8-bit KV + no_extra_bufts forced on (working copy) | 22.9 s | 3.6 tok/s | 122 s | 1359 | 5 of 6 |
| `auto-4b` | Qwen3-4B | final: repack rule, 8-bit KV, length from each prompt | final code, b19e7037 (working copy) | 26.3 s | 3.7 tok/s | 98 s | 1306 | 6 of 6 |
| `base-15b` | Qwen2.5-1.5B | baseline | main a6633f8d | 20.0 s | 6.4 tok/s | 112 s | 2849 | 3 of 6 |
| `fix-15b` | Qwen2.5-1.5B | final | final code, b19e7037 | 4.7 s | 8.0 tok/s | 48 s | 2478 | 4 of 6 |

## Question sets (`harness/`)

`npm run eval:device -- --models qwen3-4b` (standard set v1, 17 questions) and `--queries vitalik` (6), Succinct, no
history, questions back to back. Each folder has the JSONL (authoritative), the report from `npm run eval:summary`, and the
answers for grading where the run produced them.

| Run | Question set | Code | OK | First word, median | Decode, median | Total, median |
|---|---|---|---|---|---|---|
| `base-4b-std` | standard (17) | main a6633f8d | 17/17 | 9.0 s | 5.5 tok/s | 21.8 s |
| `fix-4b-std` | standard (17) | 98fd3ed2; ran right after a low-memory kill and cold restart | 17/17 | 9.2 s | 4.5 tok/s | 28.6 s |
| `fix-4b-std-rerun` | standard (17) | 98fd3ed2, fresh start | 17/17 | 9.1 s | 5.0 tok/s | 21.4 s |
| `final-4b-std` | standard (17) | PR head 429917b5 (final, rebased) | 17/17 | 23.0 s | 5.0 tok/s | 34.3 s |
| `base-4b-vitalik` | vitalik (6) | main a6633f8d | 6/6 | 1.0 s | 6.1 tok/s | 18.6 s |
| `fix-4b-vitalik` | vitalik (6) | 98fd3ed2 | 6/6 | 0.9 s | 6.3 tok/s | 13.9 s |
| `final-4b-vitalik` | vitalik (6) | PR head 429917b5 (final, rebased) | 6/6 | 1.7 s | 6.2 tok/s | 15.1 s |

## Reading the results

- **Conversations:** on the final code the 4B finished 6 of 6 answers (0 of 6 on `main`), with no 0.1 tok/s stalls; the 1.5B's
  first word went from a 20 s median to 4.7 s.
- **Single questions, 4B, 6 GB phone: slower on the final code** (first word 9.0 → 23.0 s median on the standard set). The repack
  rule keeps the 4B as a mapped file on a 6 GB phone, which reads prompts about 2× slower. That buys stability in longer use
  (no stalls, no load-time kills, ~2.7 GB free instead of ~0.3–0.7 GB), and costs the first word on every question. On phones where
  the 4B fits with room to spare (`shouldRepack`, e.g. 12 GB) it still repacks and this cost doesn't apply. The Vitalik set barely
  changes (first word 1.0 → 1.7 s), since those questions skip retrieval and have short prompts.
- The 1.5B repacks under the rule on this phone, so its single-question speed is unchanged.

## Caveats

- One phone, one room; n = 6 per conversation and 17 + 6 per question set.
- Runs marked "working copy" had dev-only console logging on top of the listed commits (timing lines, and a tokenizer check
  before each answer that adds a few tens of milliseconds). No behavior change otherwise.
- `fix-4b-std` ran right after Android killed the app for low memory and is kept for completeness; `fix-4b-std-rerun` is the
  comparable run.
- Answer quality was not scored. The answers are here for the team's judge.
- Qwen3-4B on a 6 GB phone is not the setup wizard's recommendation (it recommends the 4B from ~10 GB); it is used here because
  it's the catalog default and shows the memory behavior most clearly.
