import { proxyJob } from './_shared.js';
export async function onRequest(context) { return proxyJob(context, '/jobs/fail'); }
