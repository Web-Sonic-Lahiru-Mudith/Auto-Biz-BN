import { Router } from 'express';
import {
  getAllBusinesses,
  createBusiness,
  getBusinessById,
  getBusinessStats,
  updateBusinessSettings,
  embedAllProductsController
} from '../controllers/business.controller';
import chatRouter from './chat.routes';
import productRouter from './product.routes';
import customerRouter from './customer.routes';
import orderRouter from './order.routes';

const router = Router();

router.get('/', getAllBusinesses);
router.post('/', createBusiness);
router.get('/:businessId', getBusinessById);
router.get('/:businessId/stats', getBusinessStats);
router.put('/:businessId/settings', updateBusinessSettings);
router.post('/:businessId/embed-all', embedAllProductsController);

router.use('/:businessId/chats', chatRouter);
router.use('/:businessId/products', productRouter);
router.use('/:businessId/customers', customerRouter);
router.use('/:businessId/orders', orderRouter);

export default router;
