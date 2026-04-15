/**
 * LLM client factory with provider fallback:
 *   OpenAI path:    AZURE_OPENAI_KEY + AZURE_OPENAI_ENDPOINT → AzureOpenAI
 *                   otherwise → OpenAI (OPENAI_API_KEY)
 *   Anthropic path: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY → Bedrock
 *                   otherwise → Anthropic (ANTHROPIC_API_KEY)
 */

import OpenAI, { AzureOpenAI } from "openai";
import Anthropic from "@anthropic-ai/sdk";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";

// ── OpenAI / Azure ────────────────────────────────────────────────────────────

function usesAzure(): boolean {
  return !!(process.env.AZURE_OPENAI_KEY && process.env.AZURE_OPENAI_ENDPOINT);
}

/**
 * Returns an OpenAI-compatible client and the model/deployment name to use.
 * AzureOpenAI extends OpenAI so the return type is always OpenAI.
 */
export function getOpenAIConfig(): { client: OpenAI; model: string } {
  if (usesAzure()) {
    const client = new AzureOpenAI({
      apiKey: process.env.AZURE_OPENAI_KEY,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? "2024-02-01",
      deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-4o",
    });
    // For Azure, the model param in API calls must match the deployment name
    return { client, model: process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-4o" };
  }
  return {
    client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
    model: "gpt-4o",
  };
}

// ── Anthropic / Bedrock ───────────────────────────────────────────────────────

function usesBedrock(): boolean {
  return !!(
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
  );
}

/**
 * Returns the Anthropic messages interface and the model ID to use.
 * Bedrock model IDs differ from the direct API — configure via BEDROCK_CLAUDE_MODEL
 * (Sonnet) or BEDROCK_CLAUDE_HAIKU_MODEL (Haiku) if you need a specific version.
 *
 * Pass tier="haiku" for agents that need speed over depth (e.g. reranker).
 */
export function getAnthropicConfig(tier: "sonnet" | "haiku" = "sonnet"): {
  messages: Anthropic["messages"];
  model: string;
} {
  if (usesBedrock()) {
    const client = new AnthropicBedrock({
      awsAccessKey: process.env.AWS_ACCESS_KEY_ID!,
      awsSecretKey: process.env.AWS_SECRET_ACCESS_KEY!,
      awsRegion: process.env.AWS_REGION ?? "us-east-1",
      ...(process.env.AWS_SESSION_TOKEN && {
        awsSessionToken: process.env.AWS_SESSION_TOKEN,
      }),
    });
    const sonnetModel = process.env.BEDROCK_CLAUDE_MODEL ?? "us.anthropic.claude-3-5-sonnet-20241022-v2:0";
    const model =
      tier === "haiku"
        ? (process.env.BEDROCK_CLAUDE_HAIKU_MODEL ?? sonnetModel)
        : sonnetModel;
    return {
      messages: client.messages as unknown as Anthropic["messages"],
      model,
    };
  }
  const model =
    tier === "haiku" ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6";
  return {
    messages: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }).messages,
    model,
  };
}
