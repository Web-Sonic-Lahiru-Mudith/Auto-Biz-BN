// ============================================================
// AutoBiz AI — Updated generateAIResponse()
// Orchestrator wiring generateSystemPrompt + ragService
// ============================================================

import { GoogleGenerativeAI } from "@google/generative-ai";
import { db } from "../config/supabase";
import {
  generateSystemPrompt,
  validateAIResponse,
  detectLanguage,
  BusinessContext,
  CustomerContext,
  Product,
} from "./generateSystemPrompt";
import {
  buildRAGContext,
  precomputeIntentEmbeddings,
  embedProduct,
  embedFAQs,
} from "./ragService";

const apiKey = process.env.GEMINI_API_KEY || "";
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

// Call once at server startup in index.ts
export async function initAI(): Promise<void> {
  try {
    await precomputeIntentEmbeddings();
    console.log("[AI] Precomputed intent embeddings successfully.");
  } catch (err) {
    console.error("[AI] Error initializing AI intent embeddings:", err);
  }
}

// ---------------------------------------------------------------
// MAIN: generateAIResponse
// Flexible signature to support both direct object and (businessId, phone, history, message) calls
// ---------------------------------------------------------------
export async function generateAIResponse(
  arg1: string,
  arg2: any,
  arg3: any,
  arg4?: any,
  arg5?: any
): Promise<string> {
  let customerMessage: string;
  let business: BusinessContext & { id: string };
  let conversationId: string;
  let chatHistory: Array<{ role: "user" | "model"; content: string }>;
  let customer: CustomerContext | null = null;

  // Check signature format
  if (typeof arg2 === "string" && Array.isArray(arg3)) {
    // Legacy signature: generateAIResponse(businessId, customerPhone, chatHistory, incomingMessage)
    const businessId = arg1;
    const customerPhone = arg2;
    chatHistory = arg3;
    customerMessage = arg4 || "";
    conversationId = customerPhone;

    // Fetch business profile from DB
    try {
      const bizDoc = await db.collection("businesses").doc(businessId).get();
      const bizData = bizDoc.exists ? bizDoc.data() : {};
      business = {
        id: businessId,
        name: bizData?.name || "StyleHub Clothing",
        type: bizData?.type || "Clothing Store",
        welcomeMessage: bizData?.welcomeMessage || "Hi! Welcome to our store.",
        returnPolicy: bizData?.returnPolicy || "Returns allowed within 7 days.",
        deliveryFee: Number(bizData?.deliveryFee) || 350,
        faqs: bizData?.faqs || [],
      };
    } catch (e) {
      business = {
        id: businessId,
        name: "AutoBiz Store",
        type: "Retail Store",
        welcomeMessage: "Welcome!",
        returnPolicy: "Standard returns within 7 days.",
        deliveryFee: 350,
        faqs: [],
      };
    }

    // Fetch customer details if available
    try {
      const custDoc = await db.collection("businesses").doc(businessId).collection("customers").doc(customerPhone).get();
      if (custDoc.exists) {
        const cData = custDoc.data();
        customer = {
          name: cData?.name,
          totalOrders: Number(cData?.totalOrders) || 0,
          isVip: Array.isArray(cData?.tags) && cData.tags.includes("VIP Customer"),
        };
      }
    } catch (e) {
      customer = null;
    }
  } else {
    // New signature: generateAIResponse(customerMessage, business, conversationId, chatHistory, customer)
    customerMessage = arg1;
    business = arg2;
    conversationId = arg3;
    chatHistory = arg4 || [];
    customer = arg5 || null;
  }

  const totalMessages = chatHistory.length;

  // 1. Build RAG context (parallel: intent + product search + FAQ search + session summary)
  const ragCtx = await buildRAGContext(
    business.id,
    conversationId,
    customerMessage,
    chatHistory,
    totalMessages
  );

  console.log(`[AI] Intent: ${ragCtx.intent} | Products found: ${ragCtx.relevantProducts.length}`);

  // 2. Build structured system prompt
  const systemPrompt = generateSystemPrompt(
    business,
    ragCtx.relevantProducts,
    ragCtx.sessionSummary,
    customer
  );

  // 3. Build chat history for Gemini (last 10 messages — session summary covers the rest)
  const recentHistory = chatHistory.slice(-10).map(m => ({
    role: m.role,
    parts: [{ text: m.content }],
  }));

  // 4. Call Gemini or fallback
  let response: string;
  try {
    if (genAI) {
      response = await callGemini(systemPrompt, recentHistory, customerMessage);
    } else {
      throw new Error("Gemini client not initialized");
    }
  } catch (err: any) {
    console.error("[AI] Gemini call failed, trying fallback:", err.message);
    response = await callGPT4oMiniFallback(systemPrompt, chatHistory, customerMessage);
  }

  // 5. Validate before sending
  const validation = validateAIResponse(response, ragCtx.relevantProducts);

  if (!validation.valid) {
    console.warn(`[AI] Response validation failed: ${validation.reason}`);

    if (validation.reason === "price_hallucination") {
      const lang = ragCtx.sessionSummary?.detectedLanguage ?? detectLanguage(customerMessage);
      return getSafeProductInquiryReply(lang, business.name);
    }

    if (validation.reason === "too_long" && validation.cleanedResponse) {
      return validation.cleanedResponse;
    }
  }

  if (validation.reason === "markdown_detected" && validation.cleanedResponse) {
    return validation.cleanedResponse;
  }

  return response;
}

// ---------------------------------------------------------------
// Gemini API call
// ---------------------------------------------------------------
async function callGemini(
  systemPrompt: string,
  history: Array<{ role: string; parts: Array<{ text: string }> }>,
  currentMessage: string
): Promise<string> {
  if (!genAI) throw new Error("Gemini API key missing");

  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    systemInstruction: systemPrompt,
  });

  const chat = model.startChat({
    history,
    generationConfig: {
      maxOutputTokens: 300,
      temperature: 0.4,
      topP: 0.8,
    },
  });

  const result = await chat.sendMessage(currentMessage);
  return result.response.text().trim();
}

// ---------------------------------------------------------------
// GPT-4o-mini fallback
// ---------------------------------------------------------------
async function callGPT4oMiniFallback(
  systemPrompt: string,
  history: Array<{ role: string; content: string }>,
  currentMessage: string
): Promise<string> {
  const ghToken = process.env.GITHUB_TOKEN || "";
  if (!ghToken) {
    return getSafeProductInquiryReply(detectLanguage(currentMessage), "our store");
  }

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.slice(-8).map(m => ({
      role: m.role === "model" ? "assistant" : "user",
      content: m.content,
    })),
    { role: "user", content: currentMessage },
  ];

  try {
    const res = await fetch(
      "https://models.inference.ai.azure.com/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ghToken}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages,
          max_tokens: 300,
          temperature: 0.4,
        }),
      }
    );

    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    const data = (await res.json()) as any;
    return data.choices?.[0]?.message?.content?.trim() ?? getSafeProductInquiryReply("english", "our shop");
  } catch (err: any) {
    console.error("[AI] GPT-4o-mini fallback failed:", err.message);
    return getSafeProductInquiryReply(detectLanguage(currentMessage), "our store");
  }
}

// ---------------------------------------------------------------
// Safe fallback reply when validation fails
// ---------------------------------------------------------------
function getSafeProductInquiryReply(
  lang: "english" | "singlish" | "sinhala",
  businessName: string
): string {
  const replies = {
    english: `Thanks for your interest! Could you tell me exactly which product you're looking for? I'll check the latest price and stock for you.`,
    singlish: `Ayyo, let me check that for you lah. Which item you want exactly? I'll get the price for you.`,
    sinhala: `ඔබ ඕනෑ කරන දේ කුමක්දැයි කියන්න. මම නවතම මිල සහ stock check කරනවා.`,
  };
  return replies[lang];
}

// ---------------------------------------------------------------
// HOOKS — wire these into your existing product/settings routes
// ---------------------------------------------------------------

// Call in POST /api/businesses/:id/products AND PUT /api/businesses/:id/products/:productId
export async function onProductSaved(productId: string): Promise<void> {
  embedProduct(productId).catch(err =>
    console.error("[AI] Background embedding failed:", err)
  );
}

// Call in PUT /api/businesses/:id/settings when FAQs change
export async function onFAQsSaved(
  businessId: string,
  faqs: Array<{ question: string; answer: string }>
): Promise<void> {
  embedFAQs(businessId, faqs).catch(err =>
    console.error("[AI] FAQ embedding failed:", err)
  );
}
