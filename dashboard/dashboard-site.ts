// The operator dashboard is a static site (dashboard-site/) published to Cloudflare Pages every
// 15 minutes. This Worker keeps webhooks, the queue and /api/*, and serves the dashboard pages
// from Pages, so a data refresh never redeploys the Worker.
const DEFAULT_DASHBOARD_SITE_ORIGIN = "https://clawsweeper-dashboard.pages.dev";

const PAGE_PATH =
  /^\/(?:index\.html|(?:agent|throughput|quality|queue|operations|coverage|repos)(?:\/.*)?|_astro\/.+|favicon\.png|clawsweeper\.png)?$/;

export function isDashboardSitePath(pathname: string): boolean {
  return PAGE_PATH.test(pathname);
}

export async function dashboardSiteResponse(
  request: Request,
  env: Record<string, unknown>,
): Promise<Response> {
  const configured = typeof env.DASHBOARD_SITE_ORIGIN === "string" ? env.DASHBOARD_SITE_ORIGIN : "";
  const origin = configured || DEFAULT_DASHBOARD_SITE_ORIGIN;
  const url = new URL(request.url);
  const upstream = await fetch(new URL(`${url.pathname}${url.search}`, origin), {
    method: request.method,
    headers: { accept: request.headers.get("accept") ?? "*/*" },
    redirect: "manual",
  });
  const headers = new Headers(upstream.headers);
  // Pages redirects /throughput to /throughput/; keep the visitor on this host.
  const location = headers.get("location");
  if (location) {
    const target = new URL(location, url.origin);
    headers.set("location", `${target.pathname}${target.search}`);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
