import { Router } from 'express';
import { getOrders, createOrder, updateOrder } from '../controllers/order.controller';

const router = Router({ mergeParams: true });

router.get('/', getOrders);
router.post('/', createOrder);
router.put('/:orderId', updateOrder);

export default router;
