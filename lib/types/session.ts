import type { ProfileData } from "./profile";
import type { Product } from "./product";

export type Clarification = {
  question: string;
  answer: string;
};

export type DetectedConstraint = {
  type: "budget" | "shipping" | "brand" | "material" | "form_factor" | string;
  value: string;
};

export type UserDecision = "accept" | "suggest_similar" | "reject_all";

export type FeedbackTag =
  | "price"
  | "quality"
  | "brand"
  | "style"
  | "spec"
  | string;

export type CandidatePoolEntry = Pick<
  Product,
  "id" | "title" | "price"
> & { productId: string };

export type RankedResultEntry = {
  productId: string;
  score: number;
  reason: string;
};

export type SessionLog = {
  sessionId: string;
  userId: string;
  timestamp: string;
  intent: string;
  clarifications: Clarification[];
  generatedQueries: string[];
  candidatePool: CandidatePoolEntry[];
  rankedResults: RankedResultEntry[];
  userDecision: UserDecision | null;
  acceptedProductId: string | null;
  feedbackTags: FeedbackTag[];
  feedbackText: string | null;
  profileBefore: ProfileData | null;
  profileAfter: ProfileData | null;
};

/** @deprecated — intent agent removed. Use QueryAgentOutput + judge/clarify agents separately. */
export type IntentAgentOutput = {
  needsClarification: boolean;
  clarifyingQuestion: string | null;
  detectedConstraints: DetectedConstraint[];
  searchQueries: string[];
};

/** Output of the query agent — search queries + constraints derived from the full conversation. */
export type QueryAgentOutput = {
  searchQueries: string[];
  detectedConstraints: DetectedConstraint[];
};
