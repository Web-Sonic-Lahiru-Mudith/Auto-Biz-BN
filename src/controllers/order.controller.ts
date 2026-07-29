import { Request, Response } from 'express';
import { db } from '../config/supabase';

export async function getOrders(req: Request, res: Response) {
  const { businessId } = req.params;
  try {
    const snap = await db.collection('businesses').doc(businessId).collection('orders').get();
    const orders = [];
    for (const doc of snap.docs) {
      const data = doc.data();
      const custDoc = await db.collection('businesses').doc(businessId).collection('customers').doc(data.customerId).get();
      const customerName = custDoc.exists ? (custDoc.data()?.name || data.customerId) : data.customerId;
      
      orders.push({
        id: doc.id,
        customerName,
        ...data
      });
    }
    res.json(orders);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function createOrder(req: Request, res: Response) {
  const { businessId } = req.params;
  const { customerId, items, status, total } = req.body;
  try {
    const ref = await db.collection('businesses').doc(businessId).collection('orders').add({
      customerId,
      items: items || [],
      status: status || 'pending',
      total: Number(total) || 0,
      createdAt: new Date().toISOString()
    });
    res.json({ success: true, id: ref.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateOrder(req: Request, res: Response) {
  const { businessId, orderId } = req.params;
  const { status } = req.body;
  try {
    await db.collection('businesses').doc(businessId).collection('orders').doc(orderId).set({
      status
    }, { merge: true });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
