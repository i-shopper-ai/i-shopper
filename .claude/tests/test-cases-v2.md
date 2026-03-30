# i-shopper — Test Cases v2 (Systematic Coverage Expansion)

**Coverage goal:** Address gaps in T01–T27 by adding cases for boundary conditions,
error paths, agent logic invariants, and multi-session compound behaviours.

**How to use this doc:** Same as `test-cases.md`. Run `npm run dev` → http://localhost:3000.
Where marked **(API)** the test can be run with `curl` or a REST client without a browser.
Where marked **(Browser)** it requires DevTools / manual interaction.

---

## Gap Analysis (T01–T27 baseline)

The existing suite covers the **happy path** well but leaves these areas untested:

| Area | Gap |
|---|---|
| Intent Agent | clarificationCount=1 boundary; profile with budget injected into search queries; non-English / emoji input |
| Reranker | heuristic fallback path; threshold boundary (score exactly = threshold); empty candidate list; CONFIDENCE_THRESHOLD env override |
| Profile Agent | pastSignal weight cap at 2.0; duplicate anti-preference dedup; suggest_similar without "price" tag; reject_all with no rawAttributes |
| Search / SerpAPI | Jaccard dedup boundary (score = threshold); all-zero price filter; empty queries array |
| API layer | Missing required fields (400 paths); malformed JSON body; unknown `decision` enum value |
| Profile lifecycle | Profile created on-demand when missing; budget floor (suggest_similar at min budget); profile with very large pastSignals array |
| Session continuity | Constraint chip removal triggers re-rerank (not re-search); follow-up query after null-product session |
| UI / state machine | Phase never gets stuck on "searching"; results after re-rerank respect new constraint set; clarification answer appended to history |
| Security / input hygiene | XSS payload in message field; oversized payload; userId with special characters |

---

## Section A — Intent Agent Boundaries

---

### T28 — clarificationCount = 1: second ambiguous message may still clarify
**(API)**

**What's new:** T05 tests clarificationCount=0 → question. T06 tests clarificationCount=2 → forced search. This tests the middle state where one question has been asked but the model should still be allowed to ask one more.

**Preconditions:** fresh session (clarificationCount=0)

**Steps:**
1. `POST /api/chat` — `{ "message": "I need a bag", "userId": "<id>", "clarificationCount": 0, "history": [] }`
   → captures clarifyingQuestion Q1 and assistant turn
2. `POST /api/chat` — `{ "message": "a travel bag", "userId": "<id>", "clarificationCount": 1, "history": [<prior turns>] }`

**Expected:**
- Response 1: `needsClarification: true`, one question (e.g. "What is your budget?")
- Response 2: model may return `needsClarification: true` (asking one more targeted question) **OR** `needsClarification: false`; both are valid
- Response 2 must **never** return `needsClarification: true` if `clarificationCount` was already 2
- `searchQueries` array must be non-empty in both responses (model generates queries even when clarifying)

**Test Record:**
```
Result:
Response 1 needsClarification:
Response 1 clarifyingQuestion:
Response 1 searchQueries:

Response 2 needsClarification:
Response 2 clarifyingQuestion (if any):
Response 2 searchQueries:

Notes:
```

---

### T29 — Profile budget injected into search queries
**(API)**

**What's new:** T07 verifies the intent agent avoids redundant clarification questions. This test verifies the *query content* — that the known budget actually appears in generated queries.

**Preconditions:** user with profile where `budgetRanges.default.max = 150`

**Setup:** `POST /api/onboarding` with `{ "userId": "test-budget-inject", "categories": ["electronics"], "priorityAttributes": ["price"], "antiBrands": [], "antiMaterials": [] }` then patch via `POST /api/profile/update` to set budget, or use a user from T15 (budget reduced to 425).

**Steps:**
1. `POST /api/chat` — `{ "message": "recommend me wireless earbuds", "userId": "<budget-user>", "clarificationCount": 0, "history": [] }`

**Expected:**
- `needsClarification: false` (budget known from profile, not the most ambiguous dimension)
- At least one of the `searchQueries` strings contains a dollar amount or the word "under" / "budget" referencing the profiled limit
- No constraint chip for budget if the model infers it from profile rather than from the message text

**Test Record:**
```
Result:
searchQueries:
  1.
  2.
  3.
detectedConstraints:
Budget reference present in at least one query: [ yes / no ]
Notes:
```

---

### T30 — Non-ASCII / emoji in message
**(API)**

**What's new:** No existing test sends non-ASCII input.

**Steps:**
1. `POST /api/chat` — `{ "message": "I need 🎧 headphones under $50 please", "userId": "test-emoji", "clarificationCount": 0, "history": [] }`

**Expected:**
- HTTP 200 (no 500)
- `searchQueries` are valid English strings (emoji stripped or transliterated)
- `needsClarification: false`

**Test Record:**
```
Result:
HTTP status:
searchQueries:
Notes:
```

---

### T31 — Message containing only special characters
**(API)**

**What's new:** Tests the intent agent's robustness to garbage input.

**Steps:**
1. `POST /api/chat` — `{ "message": "!@#$%^&*()", "userId": "test-special", "clarificationCount": 0, "history": [] }`

**Expected:**
- HTTP 200 (agent must not throw)
- Either: `needsClarification: true` (ask what they want) OR `searchQueries` contains generic/fallback queries
- No 500 error

**Test Record:**
```
Result:
HTTP status:
needsClarification:
clarifyingQuestion:
searchQueries:
Notes:
```

---

## Section B — Reranker Logic & Thresholds

---

### T32 — Score exactly at threshold is treated as null product
**(API)**

**What's new:** The existing T17 shows a score well below 0.6. This tests the boundary: top score = exactly `CONFIDENCE_THRESHOLD`.

**Note:** This requires mocking or carefully crafting candidates. Use the API with synthetic candidates via `/api/rerank` directly.

**Steps:**
1. Build a minimal candidate set whose attributes will likely score near 0.6 with no strong profile match.
2. `POST /api/rerank` — `{ "candidates": [<1 product with neutral attributes>], "userId": "test-threshold", "constraints": [] }`
3. Observe the `nullProduct` field for scores near the boundary.

**Alternative verification:** Set `CONFIDENCE_THRESHOLD=0.99` in `.env.local`, run any normal query, confirm `nullProduct: true` for results that previously scored 0.7–0.9.

**Expected (env override variant):**
- With `CONFIDENCE_THRESHOLD=0.99`: any normal query returns `nullProduct: true` even when products seem good
- Resetting to `CONFIDENCE_THRESHOLD=0.5`: same query returns `nullProduct: false`
- Invariant: score < threshold → `nullProduct: true` always (the post-parse guard in rerankerAgent.ts line 149)

**Test Record:**
```
Result:
CONFIDENCE_THRESHOLD tested:
Top score from reranker:
nullProduct returned:
Post-parse guard triggered (was model's nullProduct wrong): [ yes / no ]
Notes:
```

---

### T33 — Reranker with zero candidates returns null product
**(API)**

**What's new:** T17 uses a difficult query to get null results. This directly tests the empty-candidates early-return path in `rerankerAgent.ts` line 115.

**Steps:**
1. `POST /api/rerank` — `{ "candidates": [], "userId": "any-user", "constraints": [] }`

**Expected:**
- HTTP 200
- `{ "nullProduct": true, "results": [] }` — exactly this shape (no rationale key required)
- No call made to Anthropic API (short-circuit before LLM)

**Test Record:**
```
Result:
HTTP status:
Response body:
Notes:
```

---

### T34 — Heuristic fallback produces valid output shape
**(API — indirect)**

**What's new:** The heuristic fallback in `rerankerAgent.ts` (lines 86–108) activates when JSON parse fails. This path has never been explicitly exercised.

**How to test indirectly:** The heuristic is only reachable by a truncated LLM response. To simulate it in isolation, a unit test is the right tool. Document the expected shape here for future unit test coverage.

**Expected heuristic output shape:**
- `nullProduct`: `true` if top score (rating × review heuristic) < threshold, else `false`
- `rationale`: always `"Ranking by rating — profile-based scoring was unavailable for this result set."` (hardcoded string)
- `results[n].matchedAttributes`: always `["rating", "reviews"]`
- `results[n].reason`: always `"<rating>/5 stars across <reviewCount> reviews."`
- Products with `rating=0` and `reviewCount=0`: score = 0.0
- Products sorted descending by computed score
- Score formula: `(rating/5)*0.6 + (min(reviewCount,1000)/1000)*0.4`

**Test Record (unit test stub — fill in when unit tests are added):**
```
Result: pending unit test
Heuristic formula verified manually: [ yes / no ]
Notes:
```

---

### T35 — Reranker attribute trimming prevents model truncation
**(API)**

**What's new:** `rerankerAgent.ts` trims rawAttributes to MAX_ATTR_KEYS=5, MAX_ATTR_VALUE_LEN=80. This tests that the trimming occurs and doesn't corrupt attribute keys.

**Steps:**
1. Craft a product with > 5 rawAttribute keys and one value > 80 characters.
2. `POST /api/rerank` — include this product in `candidates`.
3. Confirm the response returns valid JSON (model did not truncate).

**Expected:**
- Response is valid JSON (no heuristic fallback triggered)
- The trimmed attributes don't cause a 500
- Top result has a non-null `reason` and `matchedAttributes`

**Test Record:**
```
Result:
Response was valid JSON (not heuristic fallback): [ yes / no ]
Notes:
```

---

## Section C — Profile Agent Invariants

---

### T36 — pastSignal weight cap: repeated accepts don't exceed 2.0
**(API)**

**What's new:** T16 verifies signals accumulate. This verifies the **hard cap** at weight=2.0.

**Preconditions:** User with a pastSignal already at weight=1.9 for attribute `"brand"`.

**Setup:** `POST /api/profile/update` repeatedly with `decision: "accept"` and a product whose `rawAttributes.brand` is set, until the weight is at 1.9. Then run one more accept.

**Steps:**
1. `POST /api/profile/update` — `{ "userId": "test-weight-cap", "sessionId": "s1", "decision": "accept", "acceptedProduct": { ..., "rawAttributes": { "brand": "Anker" } }, "rejectedProducts": [], "feedbackTags": [], "feedbackText": null }`
   — repeat until `pastSignals[brand].weight ≥ 1.9`
2. Run one final accept with same product.

**Expected:**
- `pastSignals` entry for `"brand"` has `weight ≤ 2.0` — never exceeds the cap
- The cap is applied by both the profileAgent system prompt rule AND the post-LLM guard in `profileAgent.ts` line 100

**Test Record:**
```
Result:
Weight after N accepts:
  N=1: weight=
  N=2: weight=
  N=3: weight=
  N=10: weight= (should be ≤ 2.0)
Weight cap enforced: [ yes / no ]
Notes:
```

---

### T37 — Duplicate anti-preferences are not added twice
**(API)**

**What's new:** No existing test verifies deduplication in `antiPreferences`. T14 adds brands to the list, but never re-runs a reject with the same brands.

**Preconditions:** User with `antiPreferences.brands = ["Nike"]` already set.

**Steps:**
1. `POST /api/profile/update` — `{ "decision": "reject_all", "rejectedProducts": [{ ..., "rawAttributes": { "brand": "Nike" } }], ... }`

**Expected:**
- `antiPreferences.brands` still contains `["Nike"]` (no duplicate `["Nike", "Nike"]`)
- Array length unchanged after this call

**Test Record:**
```
Result:
antiPreferences.brands before:
antiPreferences.brands after:
Duplicate present: [ yes / no ]
Notes:
```

---

### T38 — suggest_similar without "price" tag: budget unchanged
**(API)**

**What's new:** T15 tests suggest_similar + "price" tag → budget reduced. This tests the case where a user clicks Suggest Similar but selects "Wrong brand" instead of "Too expensive".

**Steps:**
1. `POST /api/profile/update` — `{ "decision": "suggest_similar", "feedbackTags": ["brand"], "feedbackText": null, ... }`
2. `GET /api/profile/get?userId=<id>` — check budget

**Expected:**
- `budgetRanges.default.max` is **unchanged**
- `antiPreferences.brands` may be updated (the "wrong_brand" signal from suggest_similar rule in profileAgent)

**Test Record:**
```
Result:
budgetRanges.default.max before:
budgetRanges.default.max after:
Budget unchanged: [ yes / no ]
antiPreferences.brands delta:
Notes:
```

---

### T39 — reject_all with no extractable rawAttributes: no crash
**(API)**

**What's new:** Tests profileAgent robustness when rejected products have sparse or empty `rawAttributes`. The system prompt says "Only add attributes that appear in rawAttributes" — this tests what happens when none are present.

**Steps:**
1. `POST /api/profile/update` — `{ "decision": "reject_all", "rejectedProducts": [{ "id": "p1", "title": "Mystery Product", "price": 99, "rawAttributes": {} }], "feedbackTags": ["brand"], ... }`

**Expected:**
- HTTP 200 (no crash)
- `antiPreferences.brands` and `antiPreferences.materials` unchanged (nothing to extract)
- Profile returned is still valid JSON matching the `ProfileData` schema

**Test Record:**
```
Result:
HTTP status:
antiPreferences.brands delta (should be none):
antiPreferences.materials delta (should be none):
Notes:
```

---

### T40 — suggest_similar budget floor: budget cannot go below 0
**(API)**

**What's new:** Budget reduction of 15% must be guarded against going negative. Tests the guard in `profileAgent.ts` lines 88–96.

**Setup:** Create a user with `budgetRanges.default.max = 1` (nearly zero).

**Steps:**
1. `POST /api/profile/update` — `{ "decision": "suggest_similar", "feedbackTags": ["price"], ... }` for the near-zero budget user.

**Expected:**
- `budgetRanges.default.max ≥ 0` (floor enforced)
- `budgetRanges.default.min ≥ 0`
- No negative values anywhere in `budgetRanges`

**Test Record:**
```
Result:
budgetRanges.default.max before: 1
budgetRanges.default.max after (should be ≥ 0):
Floor enforced: [ yes / no ]
Notes:
```

---

## Section D — API Validation & Error Paths

---

### T41 — /api/chat: missing userId returns 400
**(API)**

**What's new:** T26 tests a missing user gracefully at `/api/profile/get`. No test covers validation errors on the chat/search/rerank routes.

**Steps:**
1. `POST /api/chat` — `{ "message": "laptop", "clarificationCount": 0, "history": [] }` (no `userId`)

**Expected:**
- HTTP 400
- Body: `{ "error": "..." }` with a message mentioning `userId`

**Test Record:**
```
Result:
HTTP status:
Response body:
Notes:
```

---

### T42 — /api/search: empty queries array returns 400
**(API)**

**What's new:** Tests input validation on the search route.

**Steps:**
1. `POST /api/search` — `{ "queries": [], "constraints": [] }`

**Expected:**
- HTTP 400
- Body: `{ "error": "..." }` (route validates non-empty queries array)

**Test Record:**
```
Result:
HTTP status:
Response body:
Notes:
```

---

### T43 — /api/profile/update: missing decision returns 400
**(API)**

**What's new:** Tests validation in the profile update route.

**Steps:**
1. `POST /api/profile/update` — `{ "userId": "u1", "sessionId": "s1" }` (no `decision`)

**Expected:**
- HTTP 400
- Body: `{ "error": "userId, sessionId, and decision are required" }`

**Test Record:**
```
Result:
HTTP status:
Response body matches expected:  [ yes / no ]
Notes:
```

---

### T44 — /api/profile/update: unknown decision enum
**(API)**

**What's new:** Tests how the profile agent handles a decision value not in the `UserDecision` type (`"accept" | "suggest_similar" | "reject_all"`).

**Steps:**
1. `POST /api/profile/update` — `{ "userId": "u1", "sessionId": "s1", "decision": "banana", "feedbackTags": [], "rejectedProducts": [] }`

**Expected:**
- Either HTTP 400 (validation rejects unknown decision) OR
- HTTP 200 but profile is unchanged (LLM ignores unknown decision and returns profile verbatim)
- Must NOT throw an unhandled 500

**Test Record:**
```
Result:
HTTP status:
Profile changed: [ yes / no ]
Notes:
```

---

### T45 — /api/rerank: userId with special characters
**(API)**

**What's new:** Tests that a userId containing URL-unsafe characters (e.g. spaces, `<`, `>`) doesn't break the KV lookup or cause a 500.

**Steps:**
1. `POST /api/rerank` — `{ "candidates": [<one valid product>], "userId": "user with spaces & <script>", "constraints": [] }`

**Expected:**
- HTTP 200 (KV lookup returns null profile gracefully, reranker uses no-profile path)
- Results scored by general quality (no profile injection)
- No 500

**Test Record:**
```
Result:
HTTP status:
nullProduct:
Notes:
```

---

### T46 — Malformed JSON body returns 400 or 500
**(API)**

**What's new:** Tests how routes handle unparseable request bodies.

**Steps:**
1. `POST /api/chat` with `Content-Type: application/json` and body `{ invalid json }`

**Expected:**
- HTTP 400 or 500 (no unhandled crash that leaks stack traces to client)
- Response is JSON (not an HTML error page)

**Test Record:**
```
Result:
HTTP status:
Response is JSON: [ yes / no ]
Notes:
```

---

## Section E — Search / SerpAPI Deduplication

---

### T47 — Jaccard dedup: near-identical titles collapsed
**(Unit test stub)**

**What's new:** The dedup threshold (0.85) has not been tested. Products with very similar titles should collapse; products that differ only in model number should not.

**Cases to verify (document expected outcomes for future unit tests):**

| Title A | Title B | Expected Jaccard | Deduped? |
|---|---|---|---|
| "Anker USB-C Hub 4 Ports" | "Anker USB C Hub 4 Ports" | ~0.89 | yes |
| "Anker USB-C Hub 4 Ports USB 3.0" | "Anker USB-C Hub 7 Ports USB 3.0" | ~0.75 | no |
| "JBL Flip 6 Speaker" | "JBL Flip 5 Speaker" | ~0.80 | no |
| "Sony WH-1000XM5" | "Sony WH-1000XM4" | ~0.86 | yes (same tokens after normalise) |
| "" | "" | 1.0 (both empty) | yes |
| "abc" | "xyz" | 0.0 | no |

**Test Record (manual verification):**
```
Result: pending unit test
Cases manually verified: [ yes / no ]
Notes: normaliseTitle strips punctuation and lowercases; "XM5" and "XM4" both
       normalise to their token values. Check exact behaviour with an ad-hoc
       node script: node -e "require('./lib/api/serpApi')...."
```

---

### T48 — All products filtered out due to price=0
**(API)**

**What's new:** `serpApi.ts` filters products where `price > 0`. Tests what happens if the SerpAPI response is all zero-price items (edge case for "free" or "contact for price" listings).

**Steps (manual / integration):**
1. Observe the candidate pool from `/api/search` for a query known to return "contact for price" items (e.g. `enterprise software license`).

**Expected:**
- `candidates` array may be empty or very small
- Does NOT crash; empty array passed to reranker → `nullProduct: true` (T33 path)

**Test Record:**
```
Result:
Query used:
Candidates returned (count):
Any zero-price products in response: [ yes / no ]
Notes:
```

---

## Section F — Session State Machine & Constraint Re-rank

---

### T49 — Constraint chip removal re-ranks without new SerpAPI call
**(Browser + Network tab)**

**What's new:** T09 verifies results change after chip removal. This test verifies *which* API is called — re-rank only (same candidate pool), not a new search.

**Steps:**
1. Complete T08 (results showing with a budget chip).
2. Open DevTools → Network tab, filter requests.
3. Click ✕ to remove the budget chip.

**Expected:**
- `/api/rerank` called exactly once
- `/api/search` is **NOT** called again
- `/api/chat` is **NOT** called again
- Same number of candidate products in the rerank body as the original search returned

**Test Record:**
```
Result:
/api/search called: [ yes / no ]  (should be NO)
/api/rerank called: [ yes / no ]  (should be YES)
/api/chat called:   [ yes / no ]  (should be NO)
Notes:
```

---

### T50 — Follow-up query after a null-product session
**(Browser)**

**What's new:** T20 tests follow-up after a successful accept. This tests follow-up after the user clicked "Refine your request" from a null-product state.

**Steps:**
1. Trigger a null-product state (use T17 query).
2. Click **Refine your request** — UI resets to idle.
3. Send a new, more specific query.

**Expected:**
- Fresh pipeline starts: new `/api/chat` → `/api/search` → `/api/rerank` sequence
- `clarificationCount` is reset to 0 for the new query
- Constraint chips from the previous query are cleared
- `sessionRef` is re-initialised with a new `sessionId`

**Test Record:**
```
Result:
New query sent:
New sessionId different from previous: [ yes / no ]
clarificationCount reset to 0: [ yes / no ]
Old chips cleared: [ yes / no ]
New results shown: [ yes / no ]
Notes:
```

---

### T51 — Multiple constraint chips: remove one, others persist
**(Browser + Network tab)**

**What's new:** T09 removes a single chip. This tests that removing one chip from a multi-chip result set leaves the remaining chips active in the re-rank request.

**Preconditions:** T24 state — 4 constraint chips (brand, price, size, shipping).

**Steps:**
1. Remove the "price: under $120" chip only.
2. Observe the `/api/rerank` request body.

**Expected:**
- Re-rank request body `constraints` contains the remaining 3 constraints (brand, size, shipping)
- Price constraint absent from re-rank body
- Results may include higher-priced Nike shoes

**Test Record:**
```
Result:
Constraints sent in re-rank body after removal:
  1.
  2.
  3.
Price constraint absent: [ yes / no ]
Notes:
```

---

### T52 — Phase never gets stuck: API error during searching returns to idle
**(Browser)**

**What's new:** No test covers what happens when `/api/search` or `/api/rerank` returns a 500 mid-pipeline. The UI phase machine should recover.

**Steps (manual injection):**
1. Temporarily break the SerpAPI key in `.env.local` (set to an invalid value).
2. Restart `npm run dev`.
3. Send a valid query.

**Expected:**
- UI does not get stuck in "Searching…" indefinitely
- Either: error message shown to user, OR UI resets to idle with a retry prompt
- No browser console uncaught error

**Test Record:**
```
Result:
Phase after API error:
Error message shown to user: [ yes / no ]
Browser console uncaught errors: [ yes / no ]
Notes:
```

---

## Section G — Profile Lifecycle Edge Cases

---

### T53 — Profile created on-demand for unknown user in /api/profile/update
**(API)**

**What's new:** T26 tests `/api/profile/get` for an unknown user. This tests `/api/profile/update` — the route calls `createDefaultProfile(userId)` when no profile exists (line 38 of `profile/update/route.ts`).

**Steps:**
1. Use a brand-new userId that has never been seen.
2. `POST /api/profile/update` — `{ "userId": "never-seen-before-user", "sessionId": "s1", "decision": "accept", "acceptedProduct": { ... }, "rejectedProducts": [], "feedbackTags": [], "feedbackText": null }`

**Expected:**
- HTTP 200
- Response contains a valid `profile` object (created from default, then updated with the accept decision)
- `GET /api/profile/get?userId=never-seen-before-user` now returns a non-null profile
- `sessionCount: 1` in the returned profile

**Test Record:**
```
Result:
HTTP status:
Profile null before call: [ yes / no ]
Profile non-null after call: [ yes / no ]
sessionCount after: (should be 1)
Notes:
```

---

### T54 — Profile with large pastSignals array (>20 entries) still reranks correctly
**(API)**

**What's new:** No test verifies performance or correctness when the profile JSON is large. The profile is injected verbatim into both the intent agent and reranker prompts — a very large profile could push towards the token limit.

**Setup:** Run ≥20 accept decisions with different products to build up pastSignals (or manually craft a profile JSON with 25 pastSignal entries and write it via a direct KV call or mock).

**Steps:**
1. `GET /api/profile/get` — confirm `pastSignals.length >= 20`
2. `POST /api/rerank` — normal product query using this userId

**Expected:**
- HTTP 200
- Valid `RerankerOutput` returned (no truncation / heuristic fallback)
- `nullProduct` and `results` behave the same as a small-profile user for the same query

**Test Record:**
```
Result:
pastSignals count:
Heuristic fallback triggered: [ yes / no ]
HTTP status:
Notes:
```

---

## Section H — Cross-Cutting / Dark Pattern Guards

---

### T55 — Accepted product link opens correct retailerUrl
**(Browser)**

**What's new:** No test verifies the actual "Buy on [retailer]" link. A dark-pattern risk: the link should go to the product's `retailerUrl`, not an affiliate or redirect URL.

**Steps:**
1. Complete any search with results.
2. Right-click "Buy on [retailer]" on a ProductCard → copy link address.
3. Verify the URL matches the `retailerUrl` from the `/api/rerank` response.

**Expected:**
- URL is the direct product page (not a Claude/affiliate redirect)
- URL matches `results[i].retailerUrl` from the rerank response exactly

**Test Record:**
```
Result:
URL shown on card:
retailerUrl from rerank response:
Match: [ yes / no ]
Notes:
```

---

### T56 — K≤5 enforced even when reranker returns >5 results
**(API)**

**What's new:** T10 observes ≤5 cards in the UI for a normal query. This tests whether the hard K≤5 limit is enforced when the LLM returns more results than expected (model may occasionally include extra entries).

**Steps:**
1. `POST /api/rerank` with a large candidate pool (20–30 products).
2. Examine the raw `results` array in the response.

**Expected:**
- `results.length ≤ 5` (the PAGE_SIZE constant enforced at the API layer or reranker prompt)
- If the LLM returns >5, the route or the agent trims to 5 before returning

**Verify:** Check if `/app/api/rerank/route.ts` or `runRerankerAgent` truncates the array, or if it relies solely on the prompt instruction.

**Test Record:**
```
Result:
Candidate pool size sent:
results.length in response:
Enforced at: [ prompt-level / route-level / agent-level ]
If >5 returned by model — was it truncated before reaching UI: [ yes / no ]
Notes:
```

---

### T57 — No recommendation shown without user initiating search (no auto-fire)
**(Browser)**

**What's new:** The spec says "no dark patterns." This sanity check verifies the app never prefetches or auto-surfaces product results without an explicit user action.

**Steps:**
1. Load `/chat` for a fresh user (no profile).
2. Observe the page for 10 seconds without typing.

**Expected:**
- No product cards auto-appear
- No API calls to `/api/search` or `/api/rerank` in Network tab without a user message being sent

**Test Record:**
```
Result:
Any auto-fired API calls: [ yes / no ]
Notes:
```

---

## Section I — Onboarding Edge Cases

---

### T58 — Onboarding with partial selections (some cards skipped, some completed)
**(API)**

**What's new:** T01 completes all cards; T02 skips all. This tests mixed: complete cards 1 and 3, skip card 2.

**Steps:**
1. `POST /api/onboarding` — `{ "userId": "test-partial", "categories": ["electronics", "sports"], "priorityAttributes": [], "antiBrands": ["Shein"], "antiMaterials": ["plastic"] }`

**Expected:**
- HTTP 200
- Profile has `pastSignals` for the two categories (weight=1.0)
- `priorityAttributes` is empty (card 2 skipped)
- `antiPreferences.brands = ["Shein"]`
- `antiPreferences.materials = ["plastic"]`

**Test Record:**
```
Result:
HTTP status:
pastSignals count (should be 2):
priorityAttributes (should be []):
antiPreferences.brands:
antiPreferences.materials:
Notes:
```

---

### T59 — Onboarding called twice for same userId (idempotency / overwrite)
**(API)**

**What's new:** Tests what happens if onboarding is re-submitted (e.g. user refreshes mid-flow or the form double-submits). The `/api/onboarding` route calls `setProfile` which overwrites.

**Steps:**
1. First call: `POST /api/onboarding` — categories=["electronics"], antiBrands=["Nike"]
2. Second call (same userId): `POST /api/onboarding` — categories=["sports"], antiBrands=["Adidas"]
3. `GET /api/profile/get` — observe final state

**Expected:**
- Second call **overwrites** the first (onboarding creates a fresh profile from scratch)
- Final profile has `pastSignals` for "sports" only (not electronics)
- `antiPreferences.brands = ["Adidas"]` (not ["Nike", "Adidas"])

**Test Record:**
```
Result:
Final pastSignals categories:
Final antiPreferences.brands:
Second call overwrites first: [ yes / no ]
Notes:
```

---

## Section J — Security & Hygiene

---

### T60 — XSS payload in message field does not execute
**(Browser)**

**What's new:** No existing test sends adversarial HTML. The chat UI renders assistant messages — a naive render could execute injected scripts.

**Steps:**
1. Send: `<script>alert('xss')</script> I need headphones`
2. Observe the assistant response in the chat UI.

**Expected:**
- Alert dialog does NOT appear
- The `<script>` tag is escaped or stripped in the rendered message
- Normal search flow continues (product results shown)

**Test Record:**
```
Result:
Alert appeared: [ yes / no ]
Script visible as escaped text in UI: [ yes / no ]
Notes:
```

---

### T61 — Oversized payload (>100KB message) handled gracefully
**(API)**

**What's new:** Tests that very large request bodies don't cause unhandled errors or memory issues.

**Steps:**
1. `POST /api/chat` — message = a string of 100,000 random characters

**Expected:**
- Either HTTP 413 (payload too large, if Next.js/Vercel enforces a body size limit) OR
- HTTP 200 with a clarifying question or search result (LLM truncates or handles gracefully)
- No 500 / crash

**Test Record:**
```
Result:
HTTP status:
Body size limit enforced: [ yes / no ]
Notes:
```

---

## Test Run Log (v2)

| Date | Tester | Cases run | Pass | Fail | Notes |
|------|--------|-----------|------|------|-------|
|      |        |           |      |      |       |

---

## Coverage Matrix

| Feature | v1 (T01–T27) | v2 additions |
|---|---|---|
| Intent agent: clarification boundary | T05, T06 | T28 (count=1 middle state) |
| Intent agent: profile-driven queries | T07 | T29 (query content), T30–T31 (bad input) |
| Reranker: threshold boundary | — | T32 (exact threshold), T33 (empty candidates) |
| Reranker: heuristic fallback | — | T34 (shape contract) |
| Reranker: attribute trimming | — | T35 |
| Profile: weight cap | — | T36 |
| Profile: deduplication | — | T37 |
| Profile: suggest_similar without price tag | — | T38 |
| Profile: empty rawAttributes | — | T39 |
| Profile: budget floor | — | T40 |
| API validation: 400 paths | — | T41–T43 |
| API validation: unknown enum | — | T44 |
| API: special-char userId | — | T45 |
| API: malformed JSON | — | T46 |
| SerpAPI: Jaccard dedup boundary | — | T47 |
| SerpAPI: all zero-price filter | — | T48 |
| Constraint re-rank (no re-search) | T09 | T49 (network-level proof) |
| Follow-up after null product | — | T50 |
| Multi-chip: partial remove | — | T51 |
| Phase recovery from API error | — | T52 |
| Profile on-demand creation | T26 (get) | T53 (update path) |
| Large profile performance | — | T54 |
| Retailer URL integrity | — | T55 |
| K≤5 enforcement: LLM overflow | T10 | T56 (LLM returns >5) |
| No auto-fire results | — | T57 |
| Onboarding: partial cards | — | T58 |
| Onboarding: idempotency | — | T59 |
| XSS in message field | — | T60 |
| Oversized payload | — | T61 |
