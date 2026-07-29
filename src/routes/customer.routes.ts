import { Router } from 'express';
import { getCustomers, createCustomer } from '../controllers/customer.controller';

const router = Router({ mergeParams: true });

router.get('/', getCustomers);
router.post('/', createCustomer);

export default router;
