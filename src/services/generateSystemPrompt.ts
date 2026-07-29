// ============================================================
// AutoBiz AI — Structured System Prompt Builder
// ============================================================

export interface BusinessContext {
  name: string;
  type: string; // "clothing" | "food" | "pharmacy" | "salon" | "electronics" | "grocery" | string
  welcomeMessage: string;
  returnPolicy: string;
  deliveryFee: number;
  faqs: Array<{ question: string; answer: string }>;
}

export interface Product {
  id: string;
  name: string;
  price: number;
  stock: number;
  category: string;
  description?: string;
}

export interface ConversationSummary {
  summary: string;         // What the customer is interested in
  cartItems: string[];     // Items explicitly discussed / added
  orderStep: number;       // 0=browsing, 1=confirmed item, 2=got address, 3=confirmed total, 4=paid
  detectedLanguage: "english" | "singlish" | "sinhala";
}

export interface CustomerContext {
  name?: string;
  totalOrders: number;
  isVip: boolean;
}

// ---------------------------------------------------------------
// MAIN FUNCTION — call this to construct system prompt
// ---------------------------------------------------------------
export function generateSystemPrompt(
  business: BusinessContext,
  relevantProducts: Product[],        // Top 3–5 from vector search (not ALL products)
  sessionSummary: ConversationSummary | null,
  customer: CustomerContext | null
): string {

  const languageInstruction = buildLanguageInstruction(
    sessionSummary?.detectedLanguage ?? "english"
  );

  const productsBlock = buildProductsBlock(relevantProducts);

  const faqBlock = business.faqs.length > 0
    ? `<faqs>\n${business.faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join("\n\n")}\n</faqs>`
    : "";

  const sessionBlock = sessionSummary?.summary
    ? `<session_context>
Customer interest: ${sessionSummary.summary}
Cart discussed: ${sessionSummary.cartItems.length > 0 ? sessionSummary.cartItems.join(", ") : "nothing yet"}
Order step: ${sessionSummary.orderStep}/4
</session_context>`
    : "";

  const customerBlock = customer
    ? `<customer_context>
Name: ${customer.name ?? "unknown"}
Order history: ${customer.totalOrders} previous orders
VIP: ${customer.isVip ? "yes — greet warmly, prioritise" : "no"}
</customer_context>`
    : "";

  // Delivery fee string
  const deliveryFeeStr = business.deliveryFee > 0
    ? `LKR ${business.deliveryFee.toLocaleString()}`
    : "free";

  return `<role>
You are the AI sales assistant for ${business.name}, a ${business.type} shop in Sri Lanka.
Your job: help customers find products, answer questions, and complete orders via WhatsApp.
Welcome message context: "${business.welcomeMessage}"
</role>

<rules>
CRITICAL — follow these exactly, every single message:

1. NEVER mention a price that is not in <products>. If you don't see a price, say "let me check that for you."
2. NEVER say a product is available if stock = 0. Say "that item is currently out of stock."
3. NEVER invent products. If a product is not in <products>, say "we don't carry that right now."
4. Keep every reply under 150 words. WhatsApp users don't read long messages.
5. Never use markdown — no asterisks, no bullet points, no headers. Plain text only.
6. If a customer asks something you cannot answer from <products> or <faqs>, say "let me connect you with our team" and set ESCALATE=true in your thinking.
7. Return policy: ${business.returnPolicy}
8. Delivery fee: ${deliveryFeeStr}
</rules>

${languageInstruction}

${sessionBlock}

${customerBlock}

${productsBlock}

${faqBlock}

<order_flow>
When a customer wants to buy, follow these steps in order. Do NOT skip steps.

Step 1 — Confirm item and quantity
  Ask: "Great! How many [item] would you like?"
  Wait for confirmation before proceeding.

Step 2 — Get delivery address
  Ask: "What's the delivery address?"
  Accept any format (house number, city, landmark).

Step 3 — Confirm total
  State: "Your total is [quantity × price + delivery fee] LKR. Shall I send the payment link?"
  ONLY use prices from <products>. Calculate: (quantity × unit_price) + ${business.deliveryFee}.

Step 4 — Send payment link
  Say: "Here's your payment link: [CHECKOUT_URL]"
  The system will auto-generate [CHECKOUT_URL] — do not invent a URL.

Current order step for this conversation: ${sessionSummary?.orderStep ?? 0}/4
${sessionSummary?.orderStep && sessionSummary.orderStep > 0
  ? `Resume from step ${sessionSummary.orderStep + 1}.`
  : "Start from step 1 when customer is ready to buy."
}
</order_flow>

<response_format>
- Plain conversational text. No bullet points. No markdown.
- If recommending a product: name, price in LKR, one-sentence description.
- If out of stock: say so, offer the closest alternative from <products>.
- End every reply with one clear next-step question or action.
- Maximum 3 sentences for simple queries. Maximum 5 sentences for product recommendations.
</response_format>`;
}

// ---------------------------------------------------------------
// HELPER: build the products block — only injected products
// ---------------------------------------------------------------
function buildProductsBlock(products: Product[]): string {
  if (products.length === 0) {
    return `<products>
No specific products matched this query. Ask the customer what they're looking for.
</products>`;
  }

  const lines = products.map(p => {
    const stockStatus = p.stock === 0
      ? "OUT OF STOCK"
      : p.stock <= 3
        ? `LOW STOCK (${p.stock} left)`
        : `in stock (${p.stock} units)`;

    return `- ${p.name} | LKR ${p.price.toLocaleString()} | ${stockStatus}${p.description ? ` | ${p.description}` : ""}`;
  });

  return `<products>
These are the ONLY products you may discuss in this conversation.
Do NOT mention any product not listed here.

${lines.join("\n")}
</products>`;
}

// ---------------------------------------------------------------
// HELPER: language instruction block
// ---------------------------------------------------------------
function buildLanguageInstruction(
  lang: "english" | "singlish" | "sinhala"
): string {
  const instructions: Record<string, string> = {
    english: `<language>
Respond in clear, simple English. Avoid jargon.
Use friendly, conversational tone — like a helpful shopkeeper.
</language>`,

    singlish: `<language>
The customer is writing in Singlish (Sinhala-English mix).
Respond in Singlish to match their style. Examples:
- "machan, we got that jacket lah, LKR 2,500 only"
- "aney sorry, that one finished already, but got similar one"
Keep it natural — don't force Singlish words where they don't fit.
</language>`,

    sinhala: `<language>
The customer is writing in Sinhala script.
Respond fully in Sinhala script (සිංහල). Do NOT switch to English.
Keep product names in English but all other text in Sinhala.
Example: "ඔව්, T-Shirt LKR 1,500 ට තිබෙනවා. කීයක් ඕනෑද?"
</language>`,
  };

  return instructions[lang];
}

// ---------------------------------------------------------------
// LANGUAGE DETECTOR — call this on every incoming message
// ---------------------------------------------------------------
export function detectLanguage(
  message: string
): "english" | "singlish" | "sinhala" {
  // Sinhala Unicode range: U+0D80–U+0DFF
  const sinhalaChars = (message.match(/[\u0D80-\u0DFF]/g) || []).length;
  if (sinhalaChars > 2) return "sinhala";

  // Singlish markers — common Sinhala-English code-switch words
  const singlishMarkers = [
    "machan", "malli", "akka", "ayya", "lah", "neh", "aney",
    "oney", "balung", "patta", "hodai", "kohomada", "monada",
    "inne", "thiyanawa", "karanna", "denna", "ganna", "wenna",
    "ah?", "ne?", "da?", "neda?", "eka", "ekai", "aran",
  ];
  const lower = message.toLowerCase();
  const singlishCount = singlishMarkers.filter(m => lower.includes(m)).length;
  if (singlishCount >= 1) return "singlish";

  return "english";
}

// ---------------------------------------------------------------
// RESPONSE VALIDATOR — call this BEFORE sendWhatsAppMessage()
// ---------------------------------------------------------------
export interface ValidationResult {
  valid: boolean;
  reason?: "price_hallucination" | "out_of_stock_lie" | "too_long" | "markdown_detected" | "invented_product";
  cleanedResponse?: string; // Attempt to auto-fix minor issues
}

export function validateAIResponse(
  response: string,
  injectedProducts: Product[]
): ValidationResult {

  // 1. Check length
  if (response.length > 700) {
    // Try to trim at last sentence boundary under 600 chars
    const trimmed = trimToSentence(response, 600);
    return { valid: false, reason: "too_long", cleanedResponse: trimmed };
  }

  // 2. Check for price hallucination
  const pricePattern = /(?:Rs\.?|LKR|රු\.?)\s*[\d,]+/gi;
  const mentionedPrices = [...response.matchAll(pricePattern)];

  if (mentionedPrices.length > 0) {
    const validPriceStrings = new Set(
      injectedProducts.map(p => p.price.toString().replace(/,/g, ""))
    );

    for (const match of mentionedPrices) {
      const digits = match[0].replace(/[^0-9]/g, "");
      // Allow delivery totals (price + delivery) — check if digits match any product price
      // or any (product_price + delivery_fee) combo
      const isKnown = [...validPriceStrings].some(v =>
        digits === v || digits === (parseInt(v) + 350).toString() || digits === (parseInt(v) + 250).toString()
      );
      if (!isKnown) {
        return { valid: false, reason: "price_hallucination" };
      }
    }
  }

  // 3. Check for markdown (asterisks, bullet dashes at line start, headers)
  const markdownPattern = /(\*{1,2}[^*]+\*{1,2}|^#{1,3}\s|^[-*]\s)/m;
  if (markdownPattern.test(response)) {
    const cleaned = response
      .replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1")   // remove bold/italic
      .replace(/^#{1,3}\s.+$/gm, "")              // remove headers
      .replace(/^[-*]\s/gm, "")                   // remove list bullets
      .trim();
    return { valid: true, reason: "markdown_detected", cleanedResponse: cleaned };
  }

  return { valid: true };
}

function trimToSentence(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.substring(0, maxLen);
  const lastPeriod = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("?"), cut.lastIndexOf("!"));
  return lastPeriod > maxLen * 0.6 ? text.substring(0, lastPeriod + 1) : cut.trimEnd() + "…";
}
