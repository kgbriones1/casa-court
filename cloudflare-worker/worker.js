/**
 * Proxies everydaycasa.ph/casa-events/* through to the Vercel deployment,
 * so the app appears to live on your own domain while Vercel actually hosts it.
 *
 * Deploy: wrangler deploy (see README section "Hosting under
 * everydaycasa.ph/casa-events"). Then add a Cloudflare Route:
 *   everydaycasa.ph/casa-events*  ->  this Worker
 *
 * Requires the Next.js app to be built with NEXT_PUBLIC_BASE_PATH=/casa-events
 * (see next.config.mjs) -- otherwise its internal asset paths won't line up
 * with what this Worker forwards.
 */

const VERCEL_ORIGIN = "casa-court.vercel.app"; // <-- replace with your actual *.vercel.app hostname (or custom Vercel domain)

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Rebuild the same path/query against the Vercel origin instead of everydaycasa.ph.
    const target = new URL(url.pathname + url.search, `https://${VERCEL_ORIGIN}`);

    const proxied = new Request(target.toString(), request);
    // Vercel's routing doesn't need to know the original Host -- but some setups
    // check it, so this is here in case you hit an edge case with custom domains
    // on the Vercel side.
    proxied.headers.set("Host", VERCEL_ORIGIN);

    const response = await fetch(proxied);
    // Return the response as-is; headers/cookies pass through untouched.
    return new Response(response.body, response);
  },
};
