# Semantic Fact restatement candidate

## Verdict

Rejected for #445. On the synthetic fixtures in `test/semantic-supersession.test.ts`, the stock baseline `0a7240fbf2af0e19965ee9180ff02e659f0df034` passed all 16 tests. The candidate below failed 5 of 16: it merged the duplicate, but also lost the second claim in each of the condition, value, negation and time pairs. Each loss is observed through `recallSemanticFacts` after scripted Consolidation. The project-scope fixture and existing keyed supersession and stale-exclusion fixtures passed in both arms. The duplicate fixture asserts baseline behavior, so its candidate failure is the expected deduplication, not a preservation failure.

These are deliberately high-overlap synthetic cases, not an estimate of real-world frequency. They do not establish a general stale-first rate or test a live model. The candidate keeps the old wording, so the four lost second claims also demonstrate that a newer contradictory wording cannot be returned. No private store was accessed. Coding-life is a general regression gate and does not establish Semantic Fact preservation.

## Reproduce

Run `npx vitest run test/semantic-supersession.test.ts` on the baseline with the committed fixtures; then apply the following temporary patch to `src/functions/consolidation-pipeline.ts` and rerun the same command. Remove the patch afterwards. The candidate implements #460's unkeyed-only best same-project overlap match, with first-match ties and the existing project-less Session guard; it is not shipped.

```diff
diff --git a/src/functions/consolidation-pipeline.ts b/src/functions/consolidation-pipeline.ts
--- a/src/functions/consolidation-pipeline.ts
+++ b/src/functions/consolidation-pipeline.ts
@@ -6,7 +6,8 @@ import type {
   Memory,
   MemoryProvider,
 } from "../types.js";
-import { KV, generateId } from "../state/schema.js";
+import { KV, generateId, jaccardText, jaccardOverlap } from "../state/schema.js";
+import { RESTATEMENT_OVERLAP } from "./recency-cap.js";
 import type { StateKV } from "../state/kv.js";
 import {
   SEMANTIC_MERGE_SYSTEM,
@@ -224,7 +225,20 @@ export function registerConsolidationPipelineFunction(
         if (textMatch && key && !textMatch.subject && !(await citesOnlyProject(textMatch, project))) {
           textMatch = undefined;
         }
-        const existing = textMatch ?? sameKey.find((s) => s.object === key!.object);
+        let restated: SemanticMemory | undefined;
+        if (!key && !textMatch) {
+          let best = RESTATEMENT_OVERLAP;
+          for (const s of live) {
+            if (s.subject || (s.project !== undefined && s.project !== project)) continue;
+            if (s.project === undefined && !(await citesOnlyProject(s, project))) continue;
+            const overlap = jaccardOverlap(jaccardText(fact), jaccardText(s.fact));
+            if (overlap >= best && (!restated || overlap > best)) {
+              best = overlap;
+              restated = s;
+            }
+          }
+        }
+        const existing = textMatch ?? sameKey.find((s) => s.object === key!.object) ?? restated;
         let target: SemanticMemory;
         if (existing) {
           existing.accessCount++;
```
