import { getJson } from "serpapi";
import { randomUUID } from "crypto";
import type { Product } from "@/lib/types/product";

const NUM_PER_QUERY = 10;
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

async function fetchGoogleShopping(query: string): Promise<Product[]> {
  try {
    const data = await getJson({
      engine: "google_shopping",
      q: query,
      api_key: process.env.SERPAPI_KEY,
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
  } catch {
    return [];
  }
}

// ── Amazon (fallback) ────────────────────────────────────────────────────────

async function fetchAmazon(query: string): Promise<Product[]> {
  try {
    const data = await getJson({
      engine: "amazon",
      k: query,
      api_key: process.env.SERPAPI_KEY,
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
  } catch {
    return [];
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch and deduplicate products for a list of search queries.
 * Uses Google Shopping per query; falls back to Amazon if fewer than 5 results.
 */
export async function fetchCandidates(queries: string[]): Promise<Product[]> {
  const perQuery = await Promise.all(
    queries.map(async (q) => {
      // Fire both sources in parallel; merge results regardless.
      // Avoids the sequential Google → (wait) → Amazon fallback penalty.
      const [google, amazon] = await Promise.all([
        fetchGoogleShopping(q),
        fetchAmazon(q),
      ]);
      return [...google, ...amazon];
    })
  );

  return dedup(perQuery.flat());
}
