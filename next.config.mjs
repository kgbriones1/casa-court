/** @type {import('next').NextConfig} */
const nextConfig = {
  // Set NEXT_PUBLIC_BASE_PATH="/casa-events" in Vercel's env vars if you're
  // proxying this app under everydaycasa.ph/casa-events via a Cloudflare
  // Worker. Leave it unset (or "") if you're using a plain subdomain instead
  // -- see README section "Hosting under everydaycasa.ph/casa-events".
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "",
};
export default nextConfig;
