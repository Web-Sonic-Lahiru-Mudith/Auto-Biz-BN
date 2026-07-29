import * as crypto from 'crypto';
import { db } from '../config/supabase';
import { sendWhatsAppMessage } from './whatsapp';

const PAYHERE_MERCHANT_ID = process.env.PAYHERE_MERCHANT_ID || 'MOCK_MERCHANT_ID';
const PAYHERE_SECRET = process.env.PAYHERE_SECRET || 'MOCK_SECRET';

export interface PayHereParams {
  merchant_id: string;
  return_url: string;
  cancel_url: string;
  notify_url: string;
  order_id: string;
  items: string;
  currency: string;
  amount: number;
  hash: string;
}

export function generatePayHereParams(
  businessId: string,
  plan: 'starter' | 'business' | 'enterprise'
): PayHereParams {
  const planDetails = {
    starter: { price: 7000, name: 'AutoBiz AI Starter Plan' },
    business: { price: 15000, name: 'AutoBiz AI Business Plan' },
    enterprise: { price: 50000, name: 'AutoBiz AI Enterprise Plan' }
  };

  const selected = planDetails[plan];
  const orderId = `SUB_${businessId}_${Date.now()}`;
  const amount = selected.price;
  const currency = 'LKR';

  // Generate MD5 hash for PayHere signature:
  // Hash = UpperCase (MD5 (merchant_id + order_id + amount + currency + UpperCase(MD5(payhere_secret))))
  const hashedSecret = crypto.createHash('md5').update(PAYHERE_SECRET).digest('hex').toUpperCase();
  const rawString = PAYHERE_MERCHANT_ID + orderId + amount.toFixed(2) + currency + hashedSecret;
  const hash = crypto.createHash('md5').update(rawString).digest('hex').toUpperCase();

  return {
    merchant_id: PAYHERE_MERCHANT_ID,
    return_url: `http://localhost:3000/dashboard/settings?payment=success&plan=${plan}`,
    cancel_url: `http://localhost:3000/dashboard/settings?payment=cancelled`,
    notify_url: `http://localhost:5000/api/payhere/webhook`,
    order_id: orderId,
    items: selected.name,
    currency,
    amount,
    hash
  };
}

export async function processSuccessfulPayment(orderId: string, amount: number) {
  const parts = orderId.split('_');
  if (parts[0] === 'SUB' && parts.length >= 3) {
    const businessId = parts[1];
    let plan = 'starter';
    if (amount >= 50000) plan = 'enterprise';
    else if (amount >= 15000) plan = 'business';

    console.log(`[PayHere Webhook] Updating subscription for ${businessId} to ${plan}`);

    await db.collection('businesses').doc(businessId).set({
      subscription: {
        plan,
        status: 'active',
        lastPayment: new Date().toISOString(),
        orderId
      }
    }, { merge: true });
  } else {
    // Customer product order payment success
    console.log(`[PayHere Webhook] Customer order payment SUCCESS for order: ${orderId}`);
    await handleOrderPaymentResult(orderId, 'paid', amount);
  }
}

export async function processFailedPayment(orderId: string) {
  console.log(`[PayHere Webhook] Customer order payment FAILED for order: ${orderId}`);
  await handleOrderPaymentResult(orderId, 'cancelled');
}

export async function handleOrderPaymentResult(orderId: string, status: 'paid' | 'cancelled', amount?: number) {
  try {
    // Search across businesses to find matching order
    const bizSnap = await db.collection('businesses').get();
    let targetBizId = '';
    let targetOrder: any = null;

    for (const bizDoc of bizSnap.docs) {
      const bizId = bizDoc.id;
      const orderSnap = await db.collection('businesses').doc(bizId).collection('orders').doc(orderId).get();
      if (orderSnap.exists) {
        targetBizId = bizId;
        targetOrder = orderSnap.data();
        break;
      }
    }

    // If order not found directly by ID, search by query or use default business
    if (!targetOrder) {
      const defaultBizId = process.env.DEFAULT_BUSINESS_ID || 'demo-clothing-store';
      const ordersSnap = await db.collection('businesses').doc(defaultBizId).collection('orders').get();
      for (const doc of ordersSnap.docs) {
        if (doc.id === orderId || doc.id.includes(orderId)) {
          targetBizId = defaultBizId;
          targetOrder = doc.data();
          break;
        }
      }
    }

    if (targetBizId && targetOrder) {
      // 1. Update Order status in database
      await db.collection('businesses').doc(targetBizId).collection('orders').doc(orderId).set({
        status: status === 'paid' ? 'paid' : 'cancelled'
      }, { merge: true });

      const customerPhone = targetOrder.customerId || targetOrder.phone;
      const shortOrderId = orderId.slice(-6).toUpperCase();

      if (customerPhone) {
        if (status === 'paid') {
          const successMsg = `Payment done, thank you! 🙏 Order #${shortOrderId} is confirmed. We will process your delivery shortly.`;
          await sendWhatsAppMessage(targetBizId, customerPhone, successMsg);
        } else {
          const failMsg = `Payment failed for Order #${shortOrderId}. Please try paying again using your payment link if you wish to complete the order.`;
          await sendWhatsAppMessage(targetBizId, customerPhone, failMsg);
        }
      }
    } else {
      console.warn(`[PayHere Webhook] Order record ${orderId} not found in database.`);
    }
  } catch (err) {
    console.error(`[PayHere Webhook] Error in handleOrderPaymentResult:`, err);
  }
}
