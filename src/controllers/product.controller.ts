import { Request, Response } from 'express';
import { db } from '../config/supabase';
import { onProductSaved } from '../services/generateAIResponse';

export async function getProducts(req: Request, res: Response) {
  const { businessId } = req.params;
  try {
    const snap = await db.collection('businesses').doc(businessId).collection('products').get();
    res.json(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function createProduct(req: Request, res: Response) {
  const { businessId } = req.params;
  const { name, price, stock, category, description } = req.body;
  try {
    const ref = await db.collection('businesses').doc(businessId).collection('products').add({
      name,
      price: Number(price) || 0,
      stock: Number(stock) || 0,
      category: category || 'Uncategorized',
      description: description || ''
    });
    onProductSaved(ref.id);
    res.json({ success: true, id: ref.id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function updateProduct(req: Request, res: Response) {
  const { businessId, productId } = req.params;
  const { name, price, stock, category, description } = req.body;
  try {
    await db.collection('businesses').doc(businessId).collection('products').doc(productId).set({
      name,
      price: Number(price),
      stock: Number(stock),
      category,
      description
    }, { merge: true });
    onProductSaved(productId);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}

export async function deleteProduct(req: Request, res: Response) {
  const { businessId, productId } = req.params;
  try {
    await db.collection('businesses').doc(businessId).collection('products').doc(productId).delete();
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
