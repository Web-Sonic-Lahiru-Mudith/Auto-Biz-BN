import { Request, Response } from 'express';
import { db } from '../config/supabase';
import { sendWhatsAppMessage } from '../services/whatsapp';

export async function getChats(req: Request, res: Response) {
  const { businessId } = req.params;
  try {
    const snap = await db.collection('businesses').doc(businessId).collection('conversations').get();
    
    const chats = [];
    for (const doc of snap.docs) {
      const data = doc.data();
      const custDoc = await db.collection('businesses').doc(businessId).collection('customers').doc(doc.id).get();
      const customerName = custDoc.exists ? (custDoc.data()?.name || doc.id) : doc.id;
      
      chats.push({
        id: doc.id,
        name: customerName,
        ...data
      });
    }

    chats.sort((a: any, b: any) => new Date(b.lastMessageTime).getTime() - new Date(a.lastMessageTime).getTime());
    res.json(chats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function getChatMessages(req: Request, res: Response) {
  const { businessId, chatId } = req.params;
  try {
    const snap = await db.collection('businesses').doc(businessId).collection('conversations').doc(chatId).collection('messages').orderBy('timestamp', 'asc').get();
    const list = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    await db.collection('businesses').doc(businessId).collection('conversations').doc(chatId).set({
      unread: false
    }, { merge: true });

    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function sendManualMessage(req: Request, res: Response) {
  const { businessId, chatId } = req.params;
  const { text } = req.body;
  try {
    const success = await sendWhatsAppMessage(businessId, chatId, text);
    res.json({ success });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function toggleAI(req: Request, res: Response) {
  const { businessId, chatId } = req.params;
  const { aiActive } = req.body;
  try {
    await db.collection('businesses').doc(businessId).collection('conversations').doc(chatId).set({
      aiActive
    }, { merge: true });
    res.json({ success: true, aiActive });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
