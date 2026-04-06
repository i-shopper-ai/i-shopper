import OpenAI from "openai";
import type { UserProfile } from "@/lib/types/profile";
import type { IntentAgentOutput } from "@/lib/types/session";
import { getOpenAIConfig } from "@/lib/llm-clients";

function buildSystemPrompt(
  userProfile: UserProfile | null,
  clarificationCount: number
): string {
  const profileSection = userProfile
    ? `\nThe user has an existing profile. Use it to resolve ambiguity before asking clarifying questions. Never ask about something already in the profile.\n\nUser profile:\n${JSON.stringify(userProfile.profile, null, 2)}\n`
    : "\nThis is the user's first session. No profile data is available.\n";

  const clarificationRule =
    clarificationCount < 2
      ? "If the user's intent is ambiguous, ask exactly ONE clarifying question about budget or use case."
      : "Do NOT ask any clarifying questions — the session limit of 2 has been reached. Commit to search immediately.";

  return `You are a shopping assistant. Parse the user's intent and generate product search queries.
${profileSection}
Rules:
- ${clarificationRule}
- Generate 2-3 specific, distinct product search queries (even if asking a clarifying question).
- Detect constraints (budget, shipping, brand, material, form factor, etc.).
- Return valid JSON only, no markdown, no explanation.

CRITICAL — GENDER:
  Never add a gender constraint (men's / women's / boys' / girls') to detectedConstraints or searchQueries unless the user's message explicitly contains a gendered word (e.g. "women's", "men's", "girls", "boys").
  Do NOT infer gender from product category, brand, or user profile history.
  A query like "brown running shoes" or "beige bucket hat" is gender-neutral — keep it that way.

CRITICAL — BUDGET:
  If the user's message explicitly states a price or budget (e.g. "$40–$50", "under $100", "$10,000–$15,000"), extract it as a price constraint directly. Do NOT ask a clarifying question about budget when the user has already stated one in this message.
  The user's stated budget always overrides any budget value in their profile.

Output schema:
{
  "needsClarification": boolean,
  "clarifyingQuestion": string | null,
  "detectedConstraints": [{ "type": string, "value": string }],
  "searchQueries": [string]
}`;
}

/**
 * history: all prior turns in OpenAI message format (role/content pairs).
 * The chat route is responsible for building this from the conversation state.
 * userMessage: the current user input.
 */
export async function runIntentAgent(
  userMessage: string,
  history: OpenAI.Chat.ChatCompletionMessageParam[],
  userProfile: UserProfile | null,
  clarificationCount: number
): Promise<IntentAgentOutput> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(userProfile, clarificationCount) },
    ...history,
    { role: "user", content: userMessage },
  ];

  const { client, model } = getOpenAIConfig();
  const response = await client.chat.completions.create({
    model,
    messages,
    response_format: { type: "json_object" },
    temperature: 0.2,
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("Intent agent returned empty response");

  const parsed = JSON.parse(raw) as IntentAgentOutput;

  // Post-parse guard: enforce clarification limit regardless of model output
  if (clarificationCount >= 2 && parsed.needsClarification) {
    parsed.needsClarification = false;
    parsed.clarifyingQuestion = null;
  }

  return parsed;
}
