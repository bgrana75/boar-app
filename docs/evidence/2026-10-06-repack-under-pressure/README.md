# Repacked weights vs the mapped file under memory pressure, Pixel 6a (6 Oct 2026)

Why the adaptive-repack PR doesn't pick the mapped file from the memory free at load time.

## Setup

Pixel 6a (6 GB RAM, 5.46 GiB usable), Android 16, dev build served by Metro, Qwen3-4B-Instruct-2507 Q4_K_M
(2.33 GiB file), Standard library. Each run: battery cooled to 33 °C or below and thermal status 0; then five
Chrome tabs and twelve apps opened (YouTube, Maps, Photos, Camera, Gmail, Play Store, Docs, Calendar,
Messages, Contacts, Clock, Settings); BOAR force-stopped and restarted; `npm run eval:device -- --models
qwen3-4b --no-reload` (standard set, 17 questions, Succinct).

| Run | Code | Free before BOAR started | Weights | After the load |
|---|---|---|---|---|
| `mapped-std` | the PR's first version (mapped file when the file is larger than what's free) | 2.1 GB (1.8 GiB at the load) | mapped file | 2.8 GB free, 0.26 GB of the app anonymous, 0.37 GB in swap |
| `repacked-std` | #72 at 9670543f (repacks every model whose file fits the budget) | 2.1 GB | repacked | 0.7 GB free, swap nearly full (71 MB left), 1.9 GB of the app in swap |

## Results

| | mapped file | repacked |
|---|---|---|
| Answered | 17/17 | 17/17 |
| First word, median | 25.4 s | **10.2 s** |
| First word, slowest | 74.7 s | **29.8 s** |
| Writing speed, median (slowest) | 5.3 (4.9) tok/s | 4.5 (3.9) tok/s |
| Total, median | 43.6 s | **25.3 s** |

With far less memory to spare, the repacked model was still ~2.5× faster to the first word and didn't stall.
On the same day, three repacked loads with 1.6–2.4 GB free (more apps open each time) all succeeded:
Android stopped background apps instead of BOAR. The load-time kills seen on 5 Oct (~0.8 GB free) weren't
reproduced. So the PR keeps repacking by default, and only switches to the mapped file after a repacked load
was actually killed or an answer actually stalled.

## Caveats

- One phone, one run per arm; `mapped-std` ran first, `repacked-std` ~30 minutes later after cooling back to
  33 °C. Memory pressure from the same apps, but not identical states.
- A killed repacked load was verified by writing the marker it leaves (`files/model-load.marker.json` with
  `"repacked": true`) and restarting: the 4B loaded as the mapped file and stayed the active model. The stall
  fallback is covered by unit tests only; no stall happened in these runs.
