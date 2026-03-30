export type Product = {
  id: string;
  title: string;
  price: number;
  currency: string;
  imageUrl: string;
  retailerUrl: string;
  rating: number;
  reviewCount: number;
  source: "amazon" | "google";
  rawAttributes: Record<string, string>;
};

export type RankedProduct = {
  productId: string;
  score: number;
  // null until generateBatchReasons is called for the page this product appears on
  reason: string | null;
  matchedAttributes: string[];
};

export type RerankerOutput = {
  nullProduct: boolean;
  rationale?: string; // populated when nullProduct=true, explains why confidence is low
  results: RankedProduct[];
};
