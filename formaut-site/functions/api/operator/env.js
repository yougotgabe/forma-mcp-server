import { proxyOperator } from './_shared.js';
export async function onRequest(context) { return proxyOperator(context, '/operator/env'); }
