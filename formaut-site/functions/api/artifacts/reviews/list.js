import { proxyJob } from '../../jobs/_shared.js';
export async function onRequest(context) { return proxyJob(context, '/artifacts/reviews/list'); }
