import { Router } from 'express';
import { getChats, getChatMessages, sendManualMessage, toggleAI } from '../controllers/chat.controller';

const router = Router({ mergeParams: true });

router.get('/', getChats);
router.get('/:chatId/messages', getChatMessages);
router.post('/:chatId/send', sendManualMessage);
router.post('/:chatId/toggle-ai', toggleAI);

export default router;
