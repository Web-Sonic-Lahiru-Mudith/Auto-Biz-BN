import { Request, Response } from 'express';
import { db } from '../config/supabase';

export async function getCustomers(req: Request, res: Response) {
  const { businessId } = req.params;
  try {
    const snap = await db.collection('businesses').doc(businessId).collection('customers').get();
    res.json(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function createCustomer(req: Request, res: Response) {
  const { businessId } = req.params;
  const { id, name, phone, tags, language } = req.body;
  try {
    await db.collection('businesses').doc(businessId).collection('customers').doc(id).set({
      id,
      name,
      phone,
      language: language || 'English',
      tags: tags || [],
      totalOrders: 0,
      totalSpent: 0
    });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
