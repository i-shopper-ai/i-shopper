import type { ProfileData } from "@/lib/types/profile";
import type { Product } from "@/lib/types/product";
import type { UserDecision, FeedbackTag } from "@/lib/types/session";
import { getAnthropicConfig } from "@/lib/llm-clients";

const SYSTEM_PROMPT = `You are a user preference profile updater for a shopping assistant.

You will receive:
- The user's current profile JSON
- What happened during the session (decision + accepted/rejected products + feedback)

Update the profile following these rules exactly:
1. ACCEPT decision → For each attribute matched by the accepted product, find it in pastSignals and increase weight by 0.1 (max 2.0). If the attribute is not yet in pastSignals, add it with weight 1.1 and source "accepted_product".
2. REJECT_ALL decision → Add the rejected products' brands to antiPreferences.brands, materials to antiPreferences.materials, and formFactors to antiPreferences.formFactors (deduplicate). Only add attributes that appear in rawAttributes.
3. SUGGEST_SIMILAR decision → If feedback tags include "wrong_spec" or "wrong_brand", add those to antiPreferences.
4. Profile updates are additive only. Never remove existing preferences.
5. Return ONLY the updated profile JSON matching the exact schema of the input profile. No markdown, no explanation.`;

function buildUserMessage(
  profileBefore: ProfileData,
  decision: UserDecision,
  acceptedProduct: Product | null,
  rejectedProducts: Product[],
  feedbackTags: FeedbackTag[],
  feedbackText: string | null
): string {
  return JSON.stringify(
    {
      currentProfile: profileBefore,
      session: {
        decision,
        acceptedProduct: acceptedProduct
          ? {
              title: acceptedProduct.title,
              rawAttributes: acceptedProduct.rawAttributes,
            }
          : null,
        rejectedProducts: rejectedProducts.map((p) => ({
          title: p.title,
          rawAttributes: p.rawAttributes,
        })),
        feedbackTags,
        feedbackText,
      },
    },
    null,
    2
  );
}

export async function runProfileAgent(
  profileBefore: ProfileData,
  decision: UserDecision,
  acceptedProduct: Product | null,
  rejectedProducts: Product[],
  feedbackTags: FeedbackTag[],
  feedbackText: string | null
): Promise<ProfileData> {
  const { messages, model } = getAnthropicConfig();
  const response = await messages.create({
    model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserMessage(
          profileBefore,
          decision,
          acceptedProduct,
          rejectedProducts,
          feedbackTags,
          feedbackText
        ),
      },
    ],
  });

  const raw =
    response.content[0]?.type === "text" ? response.content[0].text : null;
  if (!raw) throw new Error("Profile agent returned empty response");

  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const updated = JSON.parse(cleaned) as ProfileData;

  // Cap pastSignal weights at 2.0
  for (const signal of updated.pastSignals) {
    signal.weight = Math.min(2.0, signal.weight);
  }

  return updated;
}
