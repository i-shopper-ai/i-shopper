import OpenAI from "openai";
import type { UserProfile } from "@/lib/types/profile";
import type { QueryAgentOutput } from "@/lib/types/session";
import { getOpenAIConfig, getAnthropicConfig } from "@/lib/llm-clients";

export type JudgeDialogueTurn = { question: string; answer: string };

// ── Shared context builder ────────────────────────────────────────────────────

function buildContext(
  query: string,
  profileSection: string,
  dialogue: JudgeDialogueTurn[]
): string {
  const dialogueSection =
    dialogue.length > 0
      ? `\nClarification dialogue so far:\n${dialogue
          .map((d) => `  Bot: ${d.question}\n  User: ${d.answer}`)
          .join("\n")}`
      : "";
  return `User profile:\n${profileSection}\n\nOriginal query: "${query}"${dialogueSection}`;
}

function profileText(userProfile: UserProfile | null): string {
  return userProfile
    ? JSON.stringify(userProfile.profile, null, 2)
    : "No profile available (new user).";
}

// ── Judge agent ───────────────────────────────────────────────────────────────
// Sole decision-maker for whether a clarifying question is needed.
// Returns sufficient=true on any parse/network failure so it never blocks search.

export async function runJudgeAgent(
  query: string,
  userProfile: UserProfile | null,
  dialogue: JudgeDialogueTurn[] = [],
  clarificationCount?: number
): Promise<{ sufficient: boolean }> {
  const { messages, model } = getAnthropicConfig("haiku");

  const system = `You are a strict gatekeeper deciding whether there is enough information to make confident, personalized product recommendations.

Principle: A rule fires when the absence of the specified information would meaningfully narrow the recommendation space or make confident personalized ranking uncertain. Err strongly on the side of asking — a single clarifying question saves the user from an irrelevant result.

DEFAULT TO { "sufficient": false }. Only return true when you are fully confident that enough context exists for a precise, personalized recommendation without any additional information.

MANDATORY insufficient — return false if ANY of the following apply:

AMBIGUOUS / NON-SHOPPING INPUT
0. The query does not contain a clear shopping intent AND cannot be confidently mapped to a specific product category — e.g. "I'm cold", "I'm tired", "I need help", "what should I buy?", greetings, vague feelings, or statements without an obvious product type. Return insufficient so the clarification agent can probe what the user actually wants to buy.

GENDER & SIZING
1. Query involves clothing, shoes, or accessories AND gender is absent from the user profile, query text, AND conversation.
2. Query involves sized items (shoes, clothing, rings, mattresses, helmets) AND no size or measurement is known from the profile or conversation.
3. Query is for athletic or sports shoes AND the specific sport or activity is absent (running, basketball, hiking, cross-training differ completely).
4. Query is for bedding (sheets, duvet, comforter, mattress pad) AND bed size is absent from profile and conversation.
5. Query is for children's, kids', or baby products AND the child's age or size range is absent.

TECH & ELECTRONICS
6. Query is for a laptop or tablet AND the primary use case is absent (gaming, school/office, creative/design, general browsing differ in hardware requirements).
7. Query is for headphones, earbuds, or speakers AND the primary use context is absent (commuting/ANC, home listening, studio monitoring, gaming, sports).
8. Query is for accessories that require device compatibility (cases, cables, chargers, mounts) AND the specific device model or connector standard is absent.
9. Query is for a camera AND the primary use is absent (photography vs video, professional vs casual, sport/wildlife vs portrait differ dramatically).
10. Query is for a gaming peripheral (monitor, mouse, keyboard, headset) AND the gaming platform or genre is absent (PC vs console, FPS vs MMO vs racing).

HOME & FURNITURE
11. Query is for large furniture (sofa, bed frame, dining table, wardrobe, desk) AND the available room dimensions or required size is absent.
12. Query is for a mattress AND sleeping position (back, side, stomach) or firmness preference is absent.
13. Query is for items with indoor vs outdoor variants (furniture, rugs, lighting, paint, plants) AND the intended environment is unspecified.

HEALTH, FITNESS & PERSONAL CARE
14. Query is for fitness equipment AND the user's fitness level (beginner/intermediate/advanced) or primary goal (weight loss, strength, cardio, rehabilitation) is absent.
15. Query is for skincare or facial products AND skin type (oily, dry, sensitive, combination) is absent from profile and conversation.
16. Query is for hair care products AND hair type or primary concern (color-treated, fine, curly, scalp issue) is absent.
17. Query is for dietary supplements, protein products, or vitamins AND the user's specific health goal or relevant dietary restriction is absent.
18. Query is for eyewear (glasses frames, reading glasses) AND prescription vs non-prescription is unspecified.

SPORTS, HOBBIES & GIFTS
19. Query is for musical instruments AND the player's skill level (beginner/intermediate/advanced) is absent — beginner and advanced instruments differ in quality tier and price range.
20. Query is for outerwear (jacket, coat) or a sleeping bag AND the climate, intended season, or required temperature rating is absent.
21. Query is for pet products AND the pet species is absent, OR species is known but size/breed is absent for products where it matters (collars, food, beds, crates).
22. Query is for running or cycling gear AND the terrain or distance context is absent when it changes the product type (trail vs road running shoes; road vs mountain bike components).
23. Query explicitly indicates the item is a gift AND the recipient's gender or age is absent when the product category is gender- or age-specific.
24. Query is for professional tools, equipment, or software AND professional vs hobbyist/consumer use is unclear, where the two segments have non-overlapping product lines.

AUTOMOTIVE & VEHICLE
25. Query is for vehicle replacement parts (filters, brake pads, belts, lights, sensors, alternators, etc.) AND the vehicle's year, make, and model are absent — nearly all auto parts are fitment-specific.
26. Query is for tires AND either the tire size code (e.g., 225/65R17) or the vehicle's year/make/model is absent.
27. Query is for vehicle accessories that vary by body style or cab configuration (roof racks, tonneau covers, seat covers, floor mats) AND the specific vehicle trim or body style is absent.
28. Query is for motor oil, transmission fluid, or coolant AND the vehicle's engine type or the manufacturer-specified standard (e.g., 0W-20, Dexron VI) is absent.
29. Query is for car audio, dash cams, or infotainment upgrades AND the vehicle's dashboard/stereo cavity size (single-DIN vs double-DIN) or existing wiring harness is absent.

PRINTER & OFFICE SUPPLIES
30. Query is for ink cartridges, toner cartridges, or drum units AND the printer brand and model number are absent — cartridges are model-specific even within the same brand.
31. Query is for paper (photo paper, label sheets, specialty media) AND the printer type (inkjet vs laser) is absent, since each technology requires different coatings.

SMART HOME & CONNECTIVITY
32. Query is for smart home devices (smart plugs, bulbs, switches, sensors, locks, thermostats) AND the user's existing smart home ecosystem or voice assistant (Alexa, Google Home, Apple HomeKit, SmartThings) is absent — non-Matter devices may be incompatible across platforms.
33. Query is for a Wi-Fi router, mesh system, or range extender AND the home's approximate square footage or number of floors is absent.
34. Query is for a streaming device (Roku, Fire TV, Apple TV, Chromecast) AND the user's primary phone OS or existing ecosystem is absent, since integration quality varies by platform.

SOFTWARE & DIGITAL PRODUCTS
35. Query is for software (productivity, design, development, security) AND the user's operating system (Windows, macOS, Linux, ChromeOS) is absent — many titles are platform-exclusive.
36. Query is for a subscription service or app AND the intended platform (desktop, mobile, or cross-platform) is absent when product tiers differ by platform.
37. Query is for antivirus or security software AND the number of devices or the mix of platforms (PC, Mac, mobile) to be covered is absent.

APPLIANCES
38. Query is for a major kitchen appliance (refrigerator, dishwasher, oven/range) AND the available space dimensions or the required installation type (freestanding, built-in, counter-depth, slide-in) is absent.
39. Query is for a washer or dryer AND the installation context is absent (full-size vs compact/stackable, top-load vs front-load, gas vs electric dryer).
40. Query is for a small kitchen appliance in a category with capacity-sensitive variants (coffee maker, blender, stand mixer, air fryer, pressure cooker) AND the household size or serving quantity is absent.
41. Query is for a vacuum cleaner AND the primary flooring type (hardwood, carpet, mixed, tile) is absent — motor type, brush roll, and suction design differ substantially.
42. Query is for a water heater, HVAC system, or air purifier AND the home or room size is absent.
43. Query is for an appliance that requires specific power standards (voltage, plug type, gas hookup) AND the user's region or existing hookup type is absent when not inferable from location.

FOOD, BEVERAGE & GROCERY
44. Query is for food products AND the user has mentioned or implied dietary restrictions or allergies but has not specified which ones (gluten-free, dairy-free, nut-free, vegan, kosher, halal, etc.).
45. Query is for coffee beans or ground coffee AND the user's brewing method is absent (espresso, drip, pour-over, French press, cold brew — grind size and roast differ).
46. Query is for wine, spirits, or cocktail ingredients AND the user's taste profile or the pairing context (food pairing, sipping, mixing) is absent.
47. Query is for baby formula or specialized nutritional products AND the child's age or any physician-directed dietary needs are absent.

BABY, CHILD & SAFETY
48. Query is for a car seat AND the child's current weight and age are absent — car seat type (rear-facing infant, convertible, booster) is strictly determined by weight/age range.
49. Query is for a stroller AND the child's age or the use context (jogging, travel, everyday, double/tandem for siblings) is absent.
50. Query is for baby-wearing products (carriers, wraps, slings) AND the child's weight or the wearer's body type is absent.
51. Query is for children's toys or educational materials AND the child's age range is absent — safety certifications and developmental appropriateness are age-gated.

COSMETICS & BEAUTY
52. Query is for foundation, concealer, BB cream, or tinted moisturizer AND the user's skin tone, undertone, or shade reference is absent — shade matching is essential.
53. Query is for nail products (gel, dip powder, nail polish) AND the curing method (UV/LED lamp) or existing equipment is absent.
54. Query is for fragrance or perfume AND the user's scent family preference (floral, woody, fresh, oriental) or the occasion (daily wear, evening, office) is absent.

GARDEN, LAWN & OUTDOOR
55. Query is for plants (indoor or outdoor), seeds, or bulbs AND the user's USDA hardiness zone, climate region, or light conditions (full sun, partial shade, indoor low-light) is absent.
56. Query is for lawn care equipment (mower, trimmer, leaf blower) AND the yard size is absent — manual reel, corded electric, battery, and gas models serve different scales.
57. Query is for irrigation or watering systems AND the yard dimensions or water source type (municipal, well, rainwater) is absent.
58. Query is for fencing, decking, or outdoor structure materials AND the required linear/square footage or the intended material (wood, composite, vinyl, metal) is absent.

LIGHTING & ELECTRICAL
59. Query is for light bulbs AND the bulb base type (E26, E12, GU10, etc.) or fixture type is absent — physical compatibility is non-negotiable.
60. Query is for dimmable lighting AND the user's existing dimmer switch type or compatibility requirements are absent.
61. Query is for ceiling fans AND the room size is absent — fan diameter and CFM rating are determined by room dimensions.

TRAVEL & LUGGAGE
62. Query is for luggage (carry-on or checked) AND whether the user needs airline-compliant carry-on dimensions or checked bag sizing is absent.
63. Query is for travel adapters or voltage converters AND the destination country or countries are absent.

POWER TOOLS & HARDWARE
64. Query is for cordless power tools AND the user's existing battery platform/ecosystem (DeWalt 20V MAX, Milwaukee M18, Makita 18V LXT, etc.) is absent — batteries are ecosystem-locked and a major cost factor.
65. Query is for fasteners (screws, bolts, anchors) AND the material being fastened (drywall, wood, concrete, metal, brick) is absent.
66. Query is for plumbing fixtures or fittings AND the pipe size, material (PVC, copper, PEX), or connection standard is absent.
67. Query is for a generator AND the required wattage or the intended use (home backup, jobsite, camping) is absent.

FLOORING, PAINT & HOME IMPROVEMENT
68. Query is for flooring (tile, hardwood, laminate, vinyl) AND the room type or subfloor conditions are absent when they determine material suitability (e.g., moisture in bathrooms rules out untreated hardwood).
69. Query is for paint AND the surface type (interior wall, exterior siding, metal, wood trim, concrete) is absent — paint formulations are surface-specific.
70. Query is for window treatments (blinds, curtains, shades) AND the window dimensions are absent.

MEDICAL DEVICES & ACCESSIBILITY
71. Query is for corrective lenses or contact lenses AND the user's prescription details (or at minimum, the purpose: near-sightedness, far-sightedness, astigmatism, multifocal) are absent.
72. Query is for hearing aids or personal sound amplifiers AND the degree or type of hearing loss is absent.
73. Query is for mobility aids (wheelchair, walker, rollator, cane) AND the user's weight capacity requirements or the intended environment (indoor, outdoor, travel) is absent.
74. Query is for a CPAP or sleep apnea device AND the prescribed pressure setting or mask type preference (full-face, nasal, nasal pillow) is absent.

BATTERIES & POWER
75. Query is for batteries AND the required battery size/chemistry (AA, AAA, CR2032, 18650, 9V, etc.) or the target device is absent.
76. Query is for a portable power bank or power station AND the devices to be charged or the required capacity (mAh/Wh) is absent.

ART & CRAFT SUPPLIES
77. Query is for art supplies (paints, brushes, canvases, pencils) AND the medium (oil, acrylic, watercolor, pastel, charcoal, digital) is absent — supplies are medium-specific.
78. Query is for a sewing machine AND the user's skill level or primary use case (garment sewing, quilting, embroidery, heavy-duty upholstery) is absent.

BICYCLES, SCOOTERS & PERSONAL TRANSPORT
79. Query is for a bicycle AND the rider's height or intended use (road, mountain, hybrid, commuter, BMX) is absent — frame sizing and geometry differ entirely.
80. Query is for an e-bike or e-scooter AND the intended range or terrain (flat urban commute vs hilly) is absent — battery size and motor wattage vary.
81. Query is for a bicycle helmet AND the user's head circumference or size range is absent.

STORAGE, ORGANIZATION & CONTAINERS
82. Query is for storage solutions (shelving units, closet systems, storage bins, garage racks) AND the available space dimensions are absent.

AQUARIUM & SPECIALTY PETS
83. Query is for aquarium equipment (tank, filter, heater, lighting) AND whether the tank is freshwater or saltwater is absent — equipment lines are fundamentally different.
84. Query is for reptile or exotic pet supplies (enclosures, heating, substrate) AND the specific species is absent — temperature, humidity, and habitat needs are species-dependent.

STATIONERY & WRITING
85. Query is for pens or writing instruments AND the intended use (everyday writing, calligraphy, drawing, archival/permanent, exam-approved) is absent when it determines the ink type and nib.
86. Query is for a planner or organizer AND the preferred format (daily, weekly, monthly, academic-year vs calendar-year, size) is absent.

AUDIO & MUSIC PRODUCTION
87. Query is for studio monitors or audio interfaces AND the user's use case (home studio, professional production, podcasting, streaming) is absent.
88. Query is for DJ equipment AND the user's platform (vinyl, digital controller, standalone) or skill level is absent.

BOARD GAMES, PUZZLES & TABLETOP
89. Query is for board games or tabletop games AND the intended player count or age range of participants is absent.

SAFETY & PROTECTIVE EQUIPMENT
90. Query is for a helmet (motorcycle, skateboard, ski, climbing, construction) AND the specific activity is absent, as certification standards differ (DOT, MIPS, CE, ANSI).
91. Query is for protective gloves AND the use case is absent (chemical handling, cut-resistant kitchen, welding, cold-weather, medical exam) — materials and ratings are entirely different.

CROSS-CUTTING COMPATIBILITY
92. Query is for any consumable, refill, or replacement part (vacuum bags, water filter cartridges, shaver heads, blender jars, food processor discs) AND the parent appliance brand and model are absent.
93. Query is for any product explicitly requiring electrical compatibility (voltage, frequency, plug shape) AND the user's country or region is absent and cannot be inferred.
94. Query is for any multi-user or shared-household product (streaming subscriptions, family plans, bulk packs, multi-room systems) AND the household size or number of intended users is absent.

GENERAL CATCH-ALL (apply after all domain-specific rules)
95. The query is a generic or vague product category (e.g., "headphones", "running shoes", "laptop", "coffee maker", "sofa", "jacket") with no qualifying use case, recipient, activity, size, or platform — AND no relevant profile entry resolves the gap — return insufficient. Ask what matters most for their specific situation.
96. The query is four words or fewer, describes only a broad category, none of the above rules fire, and no relevant profile context is present — return insufficient and ask for the most critical piece of missing context.


Return valid JSON only, no markdown.
Output schema: { "sufficient": boolean }`;

  const systemWithReminder =
    clarificationCount !== undefined
      ? `${system}\n\nNOTE: You have already asked ${clarificationCount} clarifying question${clarificationCount === 1 ? "" : "s"}. Wrap up the conversation gracefully without being abrupt — strongly prefer returning { "sufficient": true } unless a truly critical piece of information is still missing.`
      : system;

  try {
    const response = await messages.create({
      model,
      max_tokens: 32,
      system: systemWithReminder,
      messages: [{ role: "user", content: buildContext(query, profileText(userProfile), dialogue) }],
    });

    const raw = response.content[0]?.type === "text" ? response.content[0].text : null;
    if (!raw) return { sufficient: false };

    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    return JSON.parse(cleaned) as { sufficient: boolean };
  } catch (err) {
    console.error("[runJudgeAgent] error — defaulting to insufficient:", err);
    return { sufficient: false };
  }
}

// ── Clarification agent ───────────────────────────────────────────────────────
// Generates a single friendly clarifying question targeting the most critical
// information gap. Also handles non-shopping and off-topic messages gracefully.

export async function runClarifyAgent(
  query: string,
  userProfile: UserProfile | null,
  dialogue: JudgeDialogueTurn[] = []
): Promise<{ question: string }> {
  const { messages, model } = getAnthropicConfig("haiku");

  const system = `You are I-Shopper, a friendly and helpful AI shopping assistant.

Your role here is to ask a single, natural clarifying question to gather the most critical missing information needed to find the right products.

Guidelines:
- If the user's message has no clear shopping intent (e.g. a greeting, a question about you, or something off-topic), warmly acknowledge them and ask what they're shopping for today.
- If there is shopping intent but key details are missing, ask the single most important question that would most narrow down the right products.
- Consolidate multiple gaps into one naturally phrased question if possible (e.g. "What's your shoe size, and are these for trail or road running?").
- Never ask about something already answered in the profile or conversation.
- Never ask about budget or color as a first question — these are not deal-breakers.
- Be warm, concise, and conversational — like a knowledgeable friend, not a form.

Return valid JSON only, no markdown.
Output schema: { "question": string }`;

  try {
    const response = await messages.create({
      model,
      max_tokens: 256,
      system,
      messages: [{ role: "user", content: buildContext(query, profileText(userProfile), dialogue) }],
    });

    const raw = response.content[0]?.type === "text" ? response.content[0].text : null;
    if (!raw) return { question: "What are you shopping for today?" };

    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    return JSON.parse(cleaned) as { question: string };
  } catch {
    return { question: "What are you shopping for today?" };
  }
}

// ── Query agent ───────────────────────────────────────────────────────────────
// Called only after the judge is satisfied. Generates precise search queries
// and extracts constraints from the full conversation context.

export async function runQueryAgent(
  originalMessage: string,
  userProfile: UserProfile | null,
  dialogue: JudgeDialogueTurn[] = []
): Promise<QueryAgentOutput> {
  const profileSection = userProfile
    ? `User profile (use to tailor queries — brand preferences, lifestyle signals, past signals):\n${JSON.stringify(userProfile.profile, null, 2)}`
    : "No profile available.";

  const dialogueSection =
    dialogue.length > 0
      ? `\nClarification dialogue:\n${dialogue
          .map((d) => `  User asked about: ${d.question}\n  User answered: ${d.answer}`)
          .join("\n")}`
      : "";

  const systemPrompt = `You're I-Shopper, an online shopping agent. Your job is to generate precise, effective product search queries based on a user's shopping request and any clarifying information collected.

${profileSection}

Rules:
- Generate 2–3 specific, distinct search queries optimized for Google Shopping results.
- Each query should reflect a slightly different angle (e.g. brand variant, use-case variant, price tier variant).
- Extract all hard constraints from the conversation: budget, brand, material, size, form factor, etc.
- NEVER add a gender constraint (men's / women's / boys' / girls') unless the user explicitly stated one.
- If the budget was stated (e.g. "under $100"), extract it as a budget constraint.
- Return valid JSON only, no markdown, no explanation.

Output schema:
{
  "searchQueries": [string],
  "detectedConstraints": [{ "type": string, "value": string }]
}`;

  const userContent = `Original request: "${originalMessage}"${dialogueSection}`;

  const { client, model } = getOpenAIConfig();

  const completionMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: userContent },
  ];

  const response = await client.chat.completions.create({
    model,
    messages: completionMessages,
    response_format: { type: "json_object" },
    temperature: 0.2,
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("Query agent returned empty response");

  return JSON.parse(raw) as QueryAgentOutput;
}
