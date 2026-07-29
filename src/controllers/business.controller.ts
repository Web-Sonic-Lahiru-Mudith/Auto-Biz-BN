import { Request, Response } from 'express';
import { db } from '../config/supabase';
import { onFAQsSaved } from '../services/generateAIResponse';
import { embedAllProducts } from '../services/ragService';

export async function getAllBusinesses(req: Request, res: Response) {
  try {
    const snap = await db.collection('businesses').get();
    const list = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function createBusiness(req: Request, res: Response) {
  try {
    const { id, name, type, whatsappNumber } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'Missing business id or name' });
    await db.collection('businesses').doc(id).set({
      name,
      type: type || 'Retail',
      whatsappNumber: whatsappNumber || '',
      createdAt: new Date().toISOString(),
      subscription: { plan: 'starter', status: 'active', lastPayment: new Date().toISOString() },
      faqs: [],
      welcomeMessage: `Welcome to ${name}!`,
      returnPolicy: 'No return policy set.',
      deliveryFee: 350
    });
    res.json({ success: true, id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function getBusinessById(req: Request, res: Response) {
  const { businessId } = req.params;
  try {
    const doc = await db.collection('businesses').doc(businessId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Business not found' });
    res.json({ id: doc.id, ...doc.data() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function getBusinessStats(req: Request, res: Response) {
  const { businessId } = req.params;
  try {
    const productsSnap = await db.collection('businesses').doc(businessId).collection('products').get();
    const customersSnap = await db.collection('businesses').doc(businessId).collection('customers').get();
    const ordersSnap = await db.collection('businesses').doc(businessId).collection('orders').get();
    const convSnap = await db.collection('businesses').doc(businessId).collection('conversations').get();

    let revenue = 0;
    let completedOrders = 0;
    ordersSnap.docs.forEach(doc => {
      const o = doc.data();
      if (o.status === 'delivered' || o.status === 'confirmed' || o.status === 'paid') {
        revenue += Number(o.total) || 0;
        completedOrders++;
      }
    });

    let totalMessages = 0;
    let automatedCount = 0;

    for (const doc of convSnap.docs) {
      const msgSnap = await db.collection('businesses').doc(businessId).collection('conversations').doc(doc.id).collection('messages').get();
      totalMessages += msgSnap.size;
      msgSnap.docs.forEach(mDoc => {
        const m = mDoc.data();
        if (m.role === 'model') automatedCount++;
      });
    }

    const automationRate = totalMessages > 0 ? Math.round((automatedCount / totalMessages) * 100) : 80;

    res.json({
      totalProducts: productsSnap.size,
      totalCustomers: customersSnap.size,
      totalOrders: ordersSnap.size,
      revenue,
      totalMessages,
      automationRate
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateBusinessSettings(req: Request, res: Response) {
  const { businessId } = req.params;
  const { welcomeMessage, returnPolicy, deliveryFee, faqs, name, whatsappNumber, whatsappToken, phoneNumberId } = req.body;
  try {
    await db.collection('businesses').doc(businessId).set({
      name,
      welcomeMessage,
      returnPolicy,
      deliveryFee: Number(deliveryFee),
      faqs,
      whatsappNumber: whatsappNumber || '',
      whatsappToken: whatsappToken || '',
      phoneNumberId: phoneNumberId || ''
    }, { merge: true });

    if (faqs && Array.isArray(faqs)) {
      onFAQsSaved(businessId, faqs);
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function embedAllProductsController(req: Request, res: Response) {
  const { businessId } = req.params;
  try {
    await embedAllProducts(businessId);
    res.json({ success: true, message: `Product embedding completed for ${businessId}` });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
