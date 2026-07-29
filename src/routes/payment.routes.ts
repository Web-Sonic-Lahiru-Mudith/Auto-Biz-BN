import { Router } from 'express';
import { createCheckout } from '../controllers/payment.controller';

const router = Router();

router.post('/checkout', createCheckout);

export default router;
