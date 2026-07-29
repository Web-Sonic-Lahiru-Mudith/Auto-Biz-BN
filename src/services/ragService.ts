// ============================================================
// AutoBiz AI — RAG Service
// Handles: embedding generation, vector search, session summaries
// ============================================================

import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";
import { detectLanguage, ConversationSummary, Product } from "./generateSystemPrompt";

const apiKey = process.env.GEMINI_API_KEY || "";
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
const supabase = createClient(supabaseUrl, supabaseKey);

// ---------------------------------------------------------------
// EMBEDDING — generate a 768-dim vector for any text
// ---------------------------------------------------------------
export async function embedText(text: string): Promise<number[]> {
  if (!genAI) {
    console.warn("[RAG] GEMINI_API_KEY not configured. Returning dummy embedding.");
    return new Array(768).fill(0.01);
  }
  const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
  const result = await model.embedContent(text);
  return result.embedding.values;
}

// ---------------------------------------------------------------
// PRODUCT EMBEDDING — call when a product is created or updated
// ---------------------------------------------------------------
export async function embedProduct(productId: string): Promise<void> {
  // Fetch the product
  const { data: product, error } = await supabase
    .from("products")
    .select("id, name, category, description, price")
    .eq("id", productId)
    .single();

  if (error || !product) {
    console.error(`[RAG] Could not fetch product ${productId}:`, error);
    return;
  }

  // Build a rich text representation — more text = better semantic match
  const textToEmbed = [
    product.name,
    product.category,
    product.description ?? "",
    `price LKR ${product.price}`,
  ]
    .filter(Boolean)
    .join(". ");

  try {
    const embedding = await embedText(textToEmbed);

    await supabase
      .from("products")
      .update({ embedding })
      .eq("id", productId);

    console.log(`[RAG] Embedded product: ${product.name}`);
  } catch (err) {
    console.error(`[RAG] Embedding failed for ${productId}:`, err);
  }
}

// ---------------------------------------------------------------
// BATCH EMBED — run once to embed all existing products
// ---------------------------------------------------------------
export async function embedAllProducts(businessId: string): Promise<void> {
  const { data: products } = await supabase
    .from("products")
    .select("id")
    .eq("business_id", businessId)
    .is("embedding", null); // Only unembedded ones

  if (!products?.length) {
    console.log("[RAG] All products already embedded or none found.");
    return;
  }

  console.log(`[RAG] Embedding ${products.length} products...`);

  for (const p of products) {
    await embedProduct(p.id);
    await sleep(50);
  }

  console.log("[RAG] Done.");
}

// ---------------------------------------------------------------
// FAQ EMBEDDING — call when FAQs are saved in Settings
// ---------------------------------------------------------------
export async function embedFAQs(
  businessId: string,
  faqs: Array<{ question: string; answer: string }>
): Promise<void> {
  // Delete old FAQ embeddings for this business
  await supabase
    .from("faq_embeddings")
    .delete()
    .eq("business_id", businessId);

  for (const faq of faqs) {
    const textToEmbed = `${faq.question} ${faq.answer}`;
    const embedding = await embedText(textToEmbed);

    await supabase.from("faq_embeddings").insert({
      business_id: businessId,
      question: faq.question,
      answer: faq.answer,
      embedding,
    });

    await sleep(50);
  }

  console.log(`[RAG] Embedded ${faqs.length} FAQs for business ${businessId}`);
}

// ---------------------------------------------------------------
// SEMANTIC PRODUCT SEARCH — core RAG function
// Returns top matching products for a customer message
// ---------------------------------------------------------------
export async function searchRelevantProducts(
  businessId: string,
  customerMessage: string,
  topK: number = 5
): Promise<Product[]> {
  try {
    const queryEmbedding = await embedText(customerMessage);

    const { data, error } = await supabase.rpc("match_products", {
      query_embedding: queryEmbedding,
      business_id_param: businessId,
      match_count: topK,
      min_similarity: 0.3,
    });

    if (error) {
      console.error("[RAG] Vector search error:", error);
      return await getFallbackProducts(businessId);
    }

    if (!data || data.length === 0) {
      return await keywordFallbackSearch(businessId, customerMessage);
    }

    return data as Product[];
  } catch (err) {
    console.error("[RAG] searchRelevantProducts failed:", err);
    return await getFallbackProducts(businessId);
  }
}

// ---------------------------------------------------------------
// SEMANTIC FAQ SEARCH
// ---------------------------------------------------------------
export async function searchRelevantFAQs(
  businessId: string,
  customerMessage: string
): Promise<Array<{ question: string; answer: string }>> {
  try {
    const queryEmbedding = await embedText(customerMessage);

    const { data, error } = await supabase.rpc("match_faqs", {
      query_embedding: queryEmbedding,
      business_id_param: businessId,
      match_count: 3,
      min_similarity: 0.4,
    });

    if (error || !data) return [];
    return data;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------
// SESSION SUMMARY — summarise every 15 messages
// ---------------------------------------------------------------
export async function getOrCreateSessionSummary(
  conversationId: string,
  businessId: string,
  recentMessages: Array<{ role: string; content: string }>,
  currentMessageCount: number
): Promise<ConversationSummary | null> {
  const { data: existing } = await supabase
    .from("conversation_summaries")
    .select("*")
    .eq("conversation_id", conversationId)
    .single();

  if (existing) {
    const lastSummaryAt = existing.message_count;
    const shouldUpdate = currentMessageCount - lastSummaryAt >= 15;

    if (!shouldUpdate) {
      return {
        summary: existing.summary,
        cartItems: existing.cart_items ?? [],
        orderStep: existing.order_step ?? 0,
        detectedLanguage: existing.detected_lang ?? "english",
      };
    }
  }

  const summaryPrompt = buildSummaryPrompt(recentMessages);

  try {
    if (!genAI) return null;
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: summaryPrompt }] }],
      generationConfig: { maxOutputTokens: 256, temperature: 0.1 },
    });

    const raw = result.response.text();
    const parsed = parseSummaryJSON(raw);

    if (!parsed) return null;

    const lastCustomerMsg = recentMessages
      .filter(m => m.role === "user")
      .slice(-1)[0]?.content ?? "";
    const detectedLang = detectLanguage(lastCustomerMsg);

    const summary: ConversationSummary = {
      summary: parsed.summary,
      cartItems: parsed.cartItems,
      orderStep: parsed.orderStep,
      detectedLanguage: detectedLang,
    };

    await supabase.from("conversation_summaries").upsert({
      conversation_id: conversationId,
      business_id: businessId,
      summary: summary.summary,
      cart_items: summary.cartItems,
      order_step: summary.orderStep,
      detected_lang: detectedLang,
      message_count: currentMessageCount,
      updated_at: new Date().toISOString(),
    }, { onConflict: "conversation_id" });

    return summary;
  } catch (err) {
    console.error("[RAG] Summary generation failed:", err);
    return null;
  }
}

// ---------------------------------------------------------------
// INTENT CLASSIFIER
// ---------------------------------------------------------------
export type MessageIntent =
  | "product_search"
  | "order_intent"
  | "order_status"
  | "faq"
  | "greeting"
  | "complaint"
  | "payment"
  | "unknown";

const INTENT_TEMPLATES: Record<MessageIntent, string[]> = {
  product_search: [
    "do you have this product available",
    "what products do you sell",
    "show me your items",
    "is this in stock",
    "how much does this cost",
    "what colors sizes do you have",
  ],
  order_intent: [
    "I want to buy this",
    "I want to order",
    "add to cart",
    "how do I purchase",
    "I will take this",
  ],
  order_status: [
    "where is my order",
    "when will it arrive",
    "delivery status",
    "my order is late",
    "track my order",
  ],
  faq: [
    "what is your return policy",
    "do you deliver",
    "how long does delivery take",
    "what payment methods",
    "cash on delivery",
  ],
  greeting: [
    "hello hi good morning",
    "hey what's up",
    "can you help me",
  ],
  complaint: [
    "this is wrong",
    "I am not happy",
    "bad quality product",
    "I want a refund",
    "this is broken",
  ],
  payment: [
    "how to pay",
    "payment link",
    "I paid already",
    "bank transfer",
  ],
  unknown: ["random message unrelated to shopping"],
};

let intentEmbeddings: Map<MessageIntent, number[][]> | null = null;

export async function precomputeIntentEmbeddings(): Promise<void> {
  console.log("[RAG] Pre-computing intent embeddings...");
  const map = new Map<MessageIntent, number[][]>();

  for (const [intent, templates] of Object.entries(INTENT_TEMPLATES)) {
    const embeddings = await Promise.all(templates.map(t => embedText(t)));
    map.set(intent as MessageIntent, embeddings);
    await sleep(50);
  }

  intentEmbeddings = map;
  console.log("[RAG] Intent embeddings ready.");
}

export async function classifyIntent(message: string): Promise<MessageIntent> {
  if (!intentEmbeddings) {
    return keywordIntentFallback(message);
  }

  const msgEmbedding = await embedText(message);

  let bestIntent: MessageIntent = "unknown";
  let bestScore = -1;

  for (const [intent, templates] of intentEmbeddings.entries()) {
    const scores = templates.map(t => cosineSimilarity(msgEmbedding, t));
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;

    if (avgScore > bestScore) {
      bestScore = avgScore;
      bestIntent = intent;
    }
  }

  return bestScore > 0.35 ? bestIntent : "unknown";
}

// ---------------------------------------------------------------
// MAIN PIPELINE
// ---------------------------------------------------------------
export interface RAGContext {
  relevantProducts: Product[];
  relevantFAQs: Array<{ question: string; answer: string }>;
  sessionSummary: ConversationSummary | null;
  intent: MessageIntent;
}

export async function buildRAGContext(
  businessId: string,
  conversationId: string,
  customerMessage: string,
  recentMessages: Array<{ role: string; content: string }>,
  totalMessageCount: number
): Promise<RAGContext> {
  const [intent, relevantProducts, relevantFAQs, sessionSummary] = await Promise.all([
    classifyIntent(customerMessage),
    searchRelevantProducts(businessId, customerMessage, 5),
    searchRelevantFAQs(businessId, customerMessage),
    getOrCreateSessionSummary(conversationId, businessId, recentMessages, totalMessageCount),
  ]);

  return { relevantProducts, relevantFAQs, sessionSummary, intent };
}

// ---------------------------------------------------------------
// INTERNAL HELPERS
// ---------------------------------------------------------------
async function getFallbackProducts(businessId: string): Promise<Product[]> {
  const { data } = await supabase
    .from("products")
    .select("id, name, price, stock, category, description")
    .eq("business_id", businessId)
    .gt("stock", 0)
    .limit(8);
  return data ?? [];
}

async function keywordFallbackSearch(
  businessId: string,
  message: string
): Promise<Product[]> {
  const words = message
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 3);

  if (words.length === 0) return getFallbackProducts(businessId);

  const query = words.map(w => `name.ilike.%${w}%`).join(",");
  const { data } = await supabase
    .from("products")
    .select("id, name, price, stock, category, description")
    .eq("business_id", businessId)
    .or(query)
    .limit(5);

  return data?.length ? data : getFallbackProducts(businessId);
}

function keywordIntentFallback(message: string): MessageIntent {
  const lower = message.toLowerCase();
  if (/hello|hi|hey|good morning|good evening|vanakkam|ayubowan/.test(lower)) return "greeting";
  if (/order|buy|purchase|want|need|eka ganna/.test(lower)) return "order_intent";
  if (/where.*order|track|delivery.*status|arrived/.test(lower)) return "order_status";
  if (/return|refund|wrong|broken|bad/.test(lower)) return "complaint";
  if (/pay|payment|link|transfer/.test(lower)) return "payment";
  if (/price|cost|much|have|stock|available|colour|color|size/.test(lower)) return "product_search";
  return "product_search";
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildSummaryPrompt(
  messages: Array<{ role: string; content: string }>
): string {
  const transcript = messages
    .slice(-20)
    .map(m => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content}`)
    .join("\n");

  return `Analyse this WhatsApp shopping conversation and return a JSON object only. No prose.

Conversation:
${transcript}

Return ONLY this JSON (no markdown, no explanation):
{
  "summary": "one sentence: what the customer is interested in and their current status",
  "cartItems": ["array of product names explicitly discussed or requested"],
  "orderStep": 0
}

orderStep values: 0=browsing, 1=confirmed item+qty, 2=got delivery address, 3=confirmed total, 4=payment sent`;
}

function parseSummaryJSON(raw: string): {
  summary: string;
  cartItems: string[];
  orderStep: number;
} | null {
  try {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
