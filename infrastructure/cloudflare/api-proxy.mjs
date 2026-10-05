export default {
	async fetch(request, environment) {
		const configured = new URL(String(environment.TREESEED_UPSTREAM_URL ?? ''));
		if (configured.protocol !== 'https:') return new Response('Upstream is unavailable.', { status: 503 });
		const incoming = new URL(request.url), target = new URL(configured);
		target.pathname = `${target.pathname.replace(/\/$/u, '')}${incoming.pathname}`;
		target.search = incoming.search;
		const headers = new Headers(request.headers);
		headers.set('x-forwarded-host', incoming.host);
		return fetch(new Request(target, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual' }));
	},
};
