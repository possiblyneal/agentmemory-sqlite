# 2026-11-21 — Session-cap count before listing

## Hypothesis

Counting a Session's Observations before listing them avoids loading and decoding every row when the Session is below its cap (#479). Once the count exceeds the cap, the existing victim selection still runs. A focused test verifies that the under-cap path does not list the scope.

## Method

Compare `main` at `929ccc12` with the combined local patches for #479, #439, #436 and #438 (tree `0e1cbcd0`). Each arm starts a throwaway daemon from the same synthetic SQLite seed with four Sessions of 1,800 Observations each, below the 2,000 cap. Four concurrent streams send 50 `observe` requests each while `/livez` is polled every 50 ms. Five paired rounds alternate arm order; one-minute load was 1.65–2.51. No live daemon or model provider was used.

## Results

| Metric (median of five rounds) | Main | Candidate |
| --- | ---: | ---: |
| `observe` p50 | 42 ms | 3 ms |
| `observe` p95 | 92 ms | 11 ms |
| `/livez` max | 62 ms | 28 ms |

Every round favored the candidate for `observe` p50 and p95. This reproduces the under-cap improvement seen with the count-only prototype at `fdc3d459` (p50 255 → 24 ms at load 23–28). The current run tested the combined tree, not the isolated count change; #439 also changes hashing on the capture path. At-cap latency was not measured. The combined gate passed 3,183 tests (1 skipped), typecheck and both Recall gates. The change remains local.
