"use client";

import type { Product, RankedProduct } from "@/lib/types/product";

interface ProductCardProps {
  product: Product;
  ranking: RankedProduct;
  lowConfidence?: boolean;
  selected?: boolean;
  onSelect: (productId: string) => void;
}

function retailerLabel(url: string, source: "amazon" | "google"): string {
  if (source === "amazon") return "Amazon";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Retailer";
  }
}

function starString(rating: number): string {
  const filled = Math.round(rating);
  return "★".repeat(filled) + "☆".repeat(Math.max(0, 5 - filled));
}

export function ProductCard({
  product,
  ranking,
  lowConfidence = false,
  selected = false,
  onSelect,
}: ProductCardProps) {
  const label = retailerLabel(product.retailerUrl, product.source);
  const classes = [
    "productCard",
    selected ? "selected" : "",
    lowConfidence ? "lowConf" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} onClick={() => onSelect(product.id)}>
      {product.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={product.imageUrl} alt={product.title} className="productImg" />
      ) : (
        <div className="productImgFallback">No image</div>
      )}

      <div className="productBody">
        {lowConfidence && <span className="lowConfBadge">Low confidence</span>}
        <p className="productTitle">{product.title}</p>
        <p className="productPrice">${product.price.toFixed(2)}</p>
        {ranking.reason && <p className="productReason">{ranking.reason}</p>}
        {product.rating > 0 && (
          <p className="productRating">
            {starString(product.rating)} ({product.reviewCount.toLocaleString()})
          </p>
        )}
      </div>

      <div className="productFooter">
        <a
          href={product.retailerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="buyBtn"
          onClick={(e) => e.stopPropagation()}
        >
          Buy on {label}
        </a>
      </div>
    </div>
  );
}
