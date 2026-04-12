import { getJson } from "serpapi";
import { randomUUID } from "crypto";
import type { Product } from "@/lib/types/product";

const NUM_PER_QUERY = 15;
const DEDUP_THRESHOLD = 0.85;

// ── Normalisation ────────────────────────────────────────────────────────────

function normaliseTitle(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean);
}

function jaccardSimilarity(a: string, b: string): number {
  const wordsA = normaliseTitle(a);
  const wordsB = normaliseTitle(b);
  if (wordsA.length === 0 && wordsB.length === 0) return 1;
  const setB = new Set(wordsB);
  const intersection = wordsA.filter((w) => setB.has(w)).length;
  const union = new Set(wordsA.concat(wordsB)).size;
  return intersection / union;
}

function dedup(products: Product[]): Product[] {
  const kept: Product[] = [];
  for (const p of products) {
    const isDupe = kept.some(
      (k) => jaccardSimilarity(k.title, p.title) > DEDUP_THRESHOLD
    );
    if (!isDupe) kept.push(p);
  }
  return kept;
}

function buildRawAttributes(
  item: Record<string, unknown>
): Record<string, string> {
  const attrs: Record<string, string> = {};
  const keys = [
    "brand",
    "material",
    "color",
    "size",
    "weight",
    "condition",
    "features",
    "extensions",
    "source",
  ];
  for (const key of keys) {
    if (item[key] == null) continue;
    attrs[key] = Array.isArray(item[key])
      ? (item[key] as unknown[]).join(", ")
      : String(item[key]);
  }
  return attrs;
}

// ── Google Shopping ──────────────────────────────────────────────────────────

async function fetchGoogleShopping(query: string, apiKey: string): Promise<Product[]> {
  const data = await getJson({
    engine: "google_shopping",
    q: query,
    api_key: apiKey,
    num: NUM_PER_QUERY,
  });

  const results = (data.shopping_results ?? []) as Record<string, unknown>[];
  return results
    .map(
      (item): Product => ({
        id: randomUUID(),
        title: String(item.title ?? ""),
        price: Number(item.extracted_price ?? 0),
        currency: "USD",
        imageUrl: String(item.thumbnail ?? ""),
        retailerUrl: String(item.link ?? ""),
        rating: Number(item.rating ?? 0),
        reviewCount: Number(item.reviews ?? 0),
        source: "google",
        rawAttributes: buildRawAttributes(item),
      })
    )
    .filter((p) => p.title && p.price > 0);
}

/** Tries the primary SERPAPI_KEY; on failure retries with SERPAPI_KEY_BACKUP. */
async function fetchGoogleShoppingWithFallback(query: string): Promise<Product[]> {
  const primary = process.env.SERPAPI_KEY ?? "";
  try {
    return await fetchGoogleShopping(query, primary);
  } catch (e) {
    const backup = process.env.SERPAPI_KEY_BACKUP;
    if (!backup) {
      console.warn("[serpApi] Primary key failed, no backup configured:", e);
      return [];
    }
    console.warn("[serpApi] Primary key failed, retrying with SERPAPI_KEY_BACKUP");
    try {
      return await fetchGoogleShopping(query, backup);
    } catch (e2) {
      console.error("[serpApi] Backup key also failed:", e2);
      return [];
    }
  }
}

// ── Amazon (fallback) ────────────────────────────────────────────────────────

async function fetchAmazon(query: string): Promise<Product[]> {
  const primary = process.env.SERPAPI_KEY ?? "";
  const backup = process.env.SERPAPI_KEY_BACKUP;
  try {
    const data = await getJson({
      engine: "amazon",
      k: query,
      api_key: primary,
    });

    const results = (data.organic_results ?? []) as Record<string, unknown>[];
    return results
      .slice(0, NUM_PER_QUERY)
      .map((item): Product => {
        const priceObj = item.price as Record<string, unknown> | undefined;
        return {
          id: randomUUID(),
          title: String(item.title ?? ""),
          price: Number(priceObj?.value ?? item.extracted_price ?? 0),
          currency: "USD",
          imageUrl: String(item.thumbnail ?? ""),
          retailerUrl: String(item.link ?? ""),
          rating: Number(item.rating ?? 0),
          reviewCount: Number(item.reviews ?? 0),
          source: "amazon",
          rawAttributes: buildRawAttributes(item),
        };
      })
      .filter((p) => p.title && p.price > 0);
  } catch (e) {
    if (!backup) return [];
    console.warn("[serpApi] Amazon primary key failed, retrying with SERPAPI_KEY_BACKUP");
    try {
      const data = await getJson({ engine: "amazon", k: query, api_key: backup });
      const results = (data.organic_results ?? []) as Record<string, unknown>[];
      return results
        .slice(0, NUM_PER_QUERY)
        .map((item): Product => {
          const priceObj = item.price as Record<string, unknown> | undefined;
          return {
            id: randomUUID(),
            title: String(item.title ?? ""),
            price: Number(priceObj?.value ?? item.extracted_price ?? 0),
            currency: "USD",
            imageUrl: String(item.thumbnail ?? ""),
            retailerUrl: String(item.link ?? ""),
            rating: Number(item.rating ?? 0),
            reviewCount: Number(item.reviews ?? 0),
            source: "amazon",
            rawAttributes: buildRawAttributes(item),
          };
        })
        .filter((p) => p.title && p.price > 0);
    } catch {
      return [];
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch and deduplicate products for a list of search queries.
 * Uses Google Shopping only — firing all queries in parallel.
 * Amazon was dropped: adding it doubled the number of simultaneous SerpAPI
 * requests (3 queries × 2 sources = 6), which triggered rate throttling and
 * pushed search latency from ~10s to 30+ seconds.
 */
/**
 * Fetch and deduplicate candidates across all queries.
 * Runs queries in parallel; fires `onBatch` with thumbnail URLs whenever a
 * query resolves so the UI can show real product previews progressively.
 */
export async function fetchCandidates(
  queries: string[],
  onBatch?: (thumbnails: string[]) => void
): Promise<Product[]> {
  const collected: Product[][] = queries.map(() => []);
  await Promise.allSettled(
    queries.map(async (query, i) => {
      const results = await fetchGoogleShoppingWithFallback(query);
      collected[i] = results;
      if (onBatch) {
        const thumbs = results
          .filter((p) => p.imageUrl?.startsWith("http"))
          .slice(0, 6)
          .map((p) => p.imageUrl);
        if (thumbs.length > 0) onBatch(thumbs);
      }
    })
  );
  return dedup(collected.flat());
}
