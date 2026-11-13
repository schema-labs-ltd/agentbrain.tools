import { clerkCsp, clerkScripts, type ClerkPage } from "./clerkui.js";
import { SCOPES, type Scope } from "./oauth.js";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `
:root { color-scheme: light dark; --bg:#f7f7f5; --fg:#1b1b1a; --muted:#5f5f5b; --card:#fff; --line:#deded8; --accent:#2f5d50; --err:#a3322b; }
@media (prefers-color-scheme: dark) { :root { --bg:#161615; --fg:#ececea; --muted:#a3a39e; --card:#20201f; --line:#34342f; --accent:#7cc0aa; --err:#ef8a80; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; }
h1 { font-size:20px; margin:0 0 4px; }
p { margin:0 0 16px; color:var(--muted); }
ul { margin:0 0 20px; padding-left:20px; }
li { margin:4px 0; }
label { display:block; font-size:14px; font-weight:600; margin:12px 0 4px; }
input { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; }
.row { display:flex; gap:12px; margin-top:20px; }
button { flex:1; padding:10px 12px; border-radius:8px; border:1px solid var(--line); background:transparent; color:inherit; font:inherit; font-weight:600; cursor:pointer; }
button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
@media (prefers-color-scheme: dark) { button.primary { color:#10201b; } }
.error { color:var(--err); margin-bottom:12px; }
.client { font-weight:600; color:var(--fg); }
.clerk { display:flex; justify-content:center; margin:8px 0 16px; }
.clerk:empty { min-height:120px; }
.clerk[hidden], [hidden] { display:none !important; }
.who { color:var(--fg); }
button.link { flex:none; padding:0; border:0; background:none; color:var(--accent); font-weight:400; text-decoration:underline; }
button:disabled { opacity:.5; cursor:not-allowed; }
main:has(.clerk) { max-width:480px; }
`;

export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

export function consentPage(opts: {
  requestId: string;
  clientName: string;
  redirectHost: string;
  scopes: Scope[];
  error?: string;
  email?: string;
  clerk?: ClerkPage;
}): string {
  const scopes = opts.scopes.map((s) => `<li>${esc(SCOPES[s])}</li>`).join("");
  const intro = `<h1>Sign in to Agent Brain</h1>
<p><span class="client">${esc(opts.clientName)}</span> wants to connect to your Agent Brain and will return to ${esc(opts.redirectHost)}.</p>
<p>It will be able to:</p>
<ul>${scopes}</ul>
${opts.error ? `<div class="error" role="alert">${esc(opts.error)}</div>` : ""}`;
  if (opts.clerk) {
    return layout(
      "Sign in to Agent Brain",
      `${intro}
<div class="error" id="clerk-status" role="alert" hidden></div>
<div id="clerk-mount" class="clerk"></div>
<form method="post" action="/authorize" id="consent">
<input type="hidden" name="request_id" value="${esc(opts.requestId)}">
<input type="hidden" name="clerk_token" value="">
<p class="who" hidden>Signed in as <span class="client" id="clerk-who"></span>. <button type="button" class="link" id="clerk-other">Use another account</button></p>
<div class="row">
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
<button type="submit" name="decision" value="allow" class="primary" disabled>Allow</button>
</div>
</form>
${clerkScripts(opts.clerk, { mode: "consent", form: "consent" })}`,
    );
  }
  return layout(
    "Sign in to Agent Brain",
    `${intro}
<form method="post" action="/authorize">
<input type="hidden" name="request_id" value="${esc(opts.requestId)}">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required value="${esc(opts.email ?? "")}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<div class="row">
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
<button type="submit" name="decision" value="allow" class="primary">Allow</button>
</div>
</form>`,
  );
}

/** Headers for the consent page when it runs Clerk's sign-in. No form-action: Allow redirects to the client. */
export function clerkPageHeaders(clerk: ClerkPage): Record<string, string> {
  return { ...PAGE_HEADERS, "content-security-policy": clerkCsp(clerk.frontendApi) };
}

export function errorPage(title: string, message: string): string {
  return layout(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>`);
}
