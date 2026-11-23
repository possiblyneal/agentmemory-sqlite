# Observation literal redaction — 2026-11-22

**Hypothesis (#515):** Redacting configured literals before automatic capture keeps those strings out of stored Observation data and Compression inputs without changing queue admission or accepted image encodings.

**Synthetic fault fixtures:** `test/observe-retry.test.ts` initially received HTTP 202 instead of 503 for unreadable rules; the corrected route rejects the request before queueing. The candidate suite checks stored payloads and Compression inputs with auto-compress off and on, and checks redaction after retry. During implementation, focused regressions also went red for an unpadded image and separate overlapping rules reads; the corrected candidate passed all 27 focused tests.

**Scope:** The fixtures do not estimate coverage of unknown identifiers, test the live store, or measure capture latency. Historical data and images are outside the redaction contract.
