import { db } from '../config/supabase';
import { generateAIResponse } from './generateAIResponse';
import { broadcastSSE } from './sse';

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '';

export async function sendWhatsAppMessage(
  businessId: string,
  toPhone: string,
  text: string,
  buttons?: { id: string; title: string }[]
): Promise<boolean> {
  console.log(`[WhatsApp Outgoing] Business: ${businessId}, To: ${toPhone}, Content: "${text}"`);

  // 1. Record message in local/firebase database
  const conversationId = toPhone; // Using phone number as conversation ID for simplicity
  const conversationRef = db.collection('businesses').doc(businessId).collection('conversations').doc(conversationId);
  const messagesRef = conversationRef.collection('messages');

  // Update/create conversation status first so that foreign key constraints are satisfied
  await conversationRef.set({
    customerId: conversationId,
    lastMessage: text,
    lastMessageTime: new Date().toISOString(),
    unread: false
  }, { merge: true });

  const messageData = {
    role: 'model',
    content: text,
    timestamp: new Date().toISOString(),
    type: 'text'
  };

  await messagesRef.add(messageData);

  // Broadcast update to SSE clients
  broadcastSSE(businessId, 'chat_updated', { customerId: conversationId });

  // 2. Get business configuration (database config overrides global env variables)
  let token = WHATSAPP_TOKEN;
  let phoneId = PHONE_NUMBER_ID;

  try {
    const bizRef = db.collection('businesses').doc(businessId);
    const bizSnap = await bizRef.get();
    if (bizSnap.exists) {
      const bizData = bizSnap.data();
      if (bizData?.whatsappToken) {
        token = bizData.whatsappToken;
      }
      if (bizData?.phoneNumberId) {
        phoneId = bizData.phoneNumberId;
      }
    }
  } catch (err) {
    console.error('Error fetching business WhatsApp config from DB:', err);
  }

  // 3. If configuration exists, send to actual Meta API
  if (token && phoneId) {
    try {
      const bodyPayload: any = {
        messaging_product: 'whatsapp',
        to: toPhone,
      };

      if (buttons && buttons.length > 0) {
        bodyPayload.type = 'interactive';
        bodyPayload.interactive = {
          type: 'button',
          body: { text: text },
          action: {
            buttons: buttons.map(b => ({
              type: 'reply',
              reply: { 
                id: b.id, 
                title: b.title.substring(0, 20) // WhatsApp limit is 20 chars
              }
            }))
          }
        };
      } else {
        bodyPayload.type = 'text';
        bodyPayload.text = { body: text };
      }

      const response = await fetch(
        `https://graph.facebook.com/v19.0/${phoneId}/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(bodyPayload)
        }
      );

      const resJson = await response.json();
      if (!response.ok) {
        console.error('Meta API response failed:', resJson);
        return false;
      }
      return true;
    } catch (e) {
      console.error('Error sending WhatsApp message to Meta:', e);
      return false;
    }
  }

  return true; // Return true for mock/simulation
}

/**
 * Handles incoming WhatsApp messages from either webhook (Meta) or simulated UI.
 */
export async function handleIncomingMessage(
  businessId: string,
  fromPhone: string,
  text: string,
  type: string = 'text',
  messageId?: string
): Promise<void> {
  console.log(`[WhatsApp Incoming] Business: ${businessId}, From: ${fromPhone}, Type: ${type}, Content: "${text}"`);

  const conversationId = fromPhone;
  const conversationRef = db.collection('businesses').doc(businessId).collection('conversations').doc(conversationId);
  const messagesRef = conversationRef.collection('messages');

  // 1. Handle non-text message types (stickers, images, audio, video, documents)
  const nonTextTypes = ['sticker', 'image', 'audio', 'video', 'document', 'reaction'];
  if (nonTextTypes.includes(type)) {
    console.log(`[WhatsApp] Received non-text message of type "${type}" from ${fromPhone}. Sending notice.`);

    // Still record the conversation so it shows in the inbox
    await conversationRef.set({
      customerId: conversationId,
      lastMessage: `[${type}]`,
      lastMessageTime: new Date().toISOString(),
      unread: true,
      aiActive: true
    }, { merge: true });

    const messageDocRef = messageId ? messagesRef.doc(messageId) : messagesRef.doc();
    await messageDocRef.set({
      role: 'user',
      content: `[${type}]`,
      timestamp: new Date().toISOString(),
      type
    });

    broadcastSSE(businessId, 'chat_updated', { customerId: conversationId });

    // Reply with a polite notice
    const stickerReply = `${type.charAt(0).toUpperCase() + type.slice(1)} messages are not supported here. Can you send us a text message? We can help you! 😊`;

    setTimeout(async () => {
      await sendWhatsAppMessage(businessId, fromPhone, stickerReply);
    }, 800);

    return; // Stop here — do not process further or call AI
  }

  // 2. Create or update conversation first so that the messages table foreign key constraint is satisfied
  const convSnap = await conversationRef.get();
  const convData = convSnap.exists ? convSnap.data() : { aiActive: true };
  const aiActive = convData?.aiActive !== false; // Default to true if not specified

  await conversationRef.set({
    customerId: conversationId,
    lastMessage: text,
    lastMessageTime: new Date().toISOString(),
    unread: true,
    aiActive
  }, { merge: true });

  // 3. Record user message (use WhatsApp message ID if available to prevent duplicates)
  const messageDocRef = messageId ? messagesRef.doc(messageId) : messagesRef.doc();
  await messageDocRef.set({
    role: 'user',
    content: text,
    timestamp: new Date().toISOString(),
    type
  });

  // Broadcast update to SSE clients
  broadcastSSE(businessId, 'chat_updated', { customerId: conversationId });

  // 4. Trigger AI Response if enabled
  if (aiActive) {
    // Fetch today's full conversation history (up to 30 messages) so the AI remembers the session
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStartISO = todayStart.toISOString();

    const historySnap = await messagesRef
      .orderBy('timestamp', 'asc')
      .where('timestamp', '>=', todayStartISO)
      .limit(30)
      .get();

    // The current message doc ID (used to exclude it from history)
    const currentDocId = messageDocRef.id;

    const chatHistory = historySnap.docs
      .filter(doc => doc.id !== currentDocId) // exclude the just-saved message
      .map(doc => {
        const data = doc.data();
        return {
          role: data.role === 'model' ? 'model' as const : 'user' as const,
          content: data.content || ''
        };
      });

    console.log(`[WhatsApp] Loaded ${chatHistory.length} messages from today's history for ${fromPhone}`);

    // Generate response using AI
    // Simulate thinking time (1-2s) to make it feel natural
    setTimeout(async () => {
      const aiReply = await generateAIResponse(businessId, fromPhone, chatHistory, text);

      // Check if AI generated a checkout link. If so, create a pending order in DB.
      const checkoutMatch = aiReply.match(/checkout\?order=(ORD_\d+)&amount=(\d+)/);
      if (checkoutMatch) {
        const orderId = checkoutMatch[1];
        const amount = Number(checkoutMatch[2]);
        
        try {
          await db.collection('businesses').doc(businessId).collection('orders').doc(orderId).set({
            id: orderId,
            customerId: fromPhone, // Critical for sending success message later
            total: amount,
            status: 'pending',
            createdAt: new Date().toISOString(),
            items: [{ name: 'Order from WhatsApp Chat', qty: 1 }]
          });
          console.log(`[WhatsApp] Intercepted checkout link and created pending order: ${orderId}`);
        } catch (err) {
          console.error(`[WhatsApp] Error creating pending order ${orderId}:`, err);
        }
      }

      await sendWhatsAppMessage(businessId, fromPhone, aiReply);
    }, 1200);
  }
}
