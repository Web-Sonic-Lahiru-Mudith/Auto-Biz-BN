import { Request, Response } from 'express';
import { generatePayHereParams } from '../services/payhere';

export function createCheckout(req: Request, res: Response) {
  const { businessId, plan } = req.body;
  if (!businessId || !plan) {
    return res.status(400).json({ error: 'Missing businessId or plan' });
  }
  const checkoutParams = generatePayHereParams(businessId, plan);
  res.json(checkoutParams);
}
